// One Express app.
//   public (any Host):  GET /.well-known/jwks.json, GET /.well-known/openid-configuration   the issuer's public keys
//   local only (/api):  health, shelf, info (settings in use), mode, mint, present
// The API can mint tokens the gateway trusts, so it refuses any request that came through a tunnel (safety.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { apiNotThroughTunnel, hostCheck, sameOriginWrites } from './safety.js';
import { createHealth } from './health.js';
import { mountShelfRoute } from './shelfLink.js';
import { publicConfig, readConfig } from './config.js';
import { mintAll } from './svid.js';
import { presentMock, presentReal } from './present.js';
import { RunObsError } from './runObservability.js';
import { createRunLog, buildRunRecord, eventOf, NO_RUN } from './runLog.js';
import { createSpireControl, parseSpireSettings, TargetError, K8S_COMMANDS, COMMAND_SHOWN, CONTAINER_NAME, SPIRE_IMAGE, LOCAL_PORT } from './spireControl.js';
import { buildGuide } from './spireGuide.js';
import { parseDemoSvidSettings, fetchDemoSvid, verifyOffCluster } from './spireDemoSvid.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST || path.resolve(HERE, '../../web/dist');
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return null; } })();
const UNREACHABLE = new Set(['mcp_unreachable', 'mcp_timeout']);

export function createApp({ store, env = process.env, now = Date.now, health = createHealth(), spire, logLine = () => {} } = {}) {
  if (!store) throw new Error('createApp needs a key store');
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(hostCheck);
  app.use(sameOriginWrites);
  app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

  // The public surface: the trusted key's PUBLIC half, and the discovery document that points at it. Nothing else.
  const publicDoc = (fn) => (_req, res) => { res.set('Cache-Control', 'public, max-age=60'); res.json(fn(readConfig(env))); };
  app.get('/.well-known/jwks.json', publicDoc(() => store.jwks()));
  app.get('/.well-known/openid-configuration', publicDoc((cfg) => ({
    issuer: cfg.issuer, jwks_uri: cfg.jwksUrl, id_token_signing_alg_values_supported: [store.alg],
    subject_types_supported: ['public'], response_types_supported: ['id_token'],
  })));

  // Rule 19: the runtime mode starts Real when it is configured (rule 26: a rebuild must not silently drop to Mock), else Mock.
  let source = readConfig(env).realAvailable ? 'real' : 'mock';

  // Run observability (rule 27): the decisions of each present run, one stdout line each (logLine), read back by GET /api/run-observability.
  const runs = createRunLog({ now, write: logLine });
  const logRun = (rows) => {
    const run = runs.begin(rows[0].source); // the mode the rows were made in, not the toggle's value after a slow Real call
    for (const r of rows) runs.record(run, eventOf(r));
    runs.end(run);
  };

  const api = express.Router();
  api.use(apiNotThroughTunnel);
  api.use(express.json({ limit: '4kb' }));
  api.use('/health', health.router);
  mountShelfRoute(api, { env });

  // SPIRE server control (education): test / start / restart an optional local SPIRE container, or
  // probe a configured remote discovery base. The command shown to the user is static text.
  const spireCtl = spire || createSpireControl({ env, dataDir: process.env.DATA_DIR || path.resolve(HERE, '../../.data'), now: () => new Date(now()) });
  api.get('/spire/command', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ command: COMMAND_SHOWN, container: CONTAINER_NAME, image: SPIRE_IMAGE, port: LOCAL_PORT, kubectl: K8S_COMMANDS });
  });
  // Which SPIRE the card works on: the Docker demo or the cluster one (SPIRE_SERVER_URL). Runtime choice, in memory, like the Mock/Real toggle.
  api.get('/spire/target', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(spireCtl.targetView()); });
  api.post('/spire/target', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return res.json(spireCtl.setTarget(req.body?.target)); }
    catch (e) {
      if (e instanceof TargetError) return res.status(e.status).json({ ok: false, error: e.code, message: e.message });
      return res.status(500).json({ ok: false, error: 'spire_target_failed', message: 'Switching the SPIRE target failed inside the lab.' });
    }
  });
  // "Set it up on your side": the steps, with this lab's trust domain / namespace / agent names filled in and the user's own SPIRE_SERVER_URL if set.
  // Static text built from settings; it carries no key, token or secret, and it names no one's host.
  api.get('/spire/guide', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const cfg = readConfig(env);
    const settings = parseSpireSettings(env);
    const { target } = spireCtl.targetView();
    // The guide's examples use the user's own URL only when the cluster is the target; the Docker demo has no public URL.
    res.json({ ...buildGuide({ trustDomain: cfg.trustDomain, namespace: cfg.namespace, agent: cfg.agent, otherAgent: cfg.otherAgent, serverUrl: target === 'cluster' ? settings.serverUrl : null }), mode: settings.mode, target, serverUrl: settings.serverUrl, problems: settings.problems });
  });
  // "Get a demo SVID" (optional): mint a short-lived JWT-SVID from a demo token service the
  // operator points at (SPIRE_DEMO_TOKEN_URL + SPIRE_DEMO_INVITE_KEY in settings). The invite
  // key stays server-side; the browser never sees it. The token is verified off-cluster
  // (issuer JWKS, signature, lifetime, subject) before it is shown with its claims.
  api.get('/spire/demo-svid/status', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const s = parseDemoSvidSettings(env);
    res.json({ available: s.available, problems: s.problems });
  });
  api.post('/spire/demo-svid', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const s = parseDemoSvidSettings(env);
    if (!s.available) return res.status(409).json({ ok: false, error: 'not-configured', problems: s.problems });
    // forward the visitor chain so the token service can rate-limit per visitor
    const forwardedFor = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '');
    const mint = await fetchDemoSvid({ settings: s, audience: s.audience, forwardedFor });
    if (!mint.ok) return res.status(mint.status >= 400 && mint.status < 500 && mint.status !== 429 ? mint.status : 502).json({ ok: false, error: mint.body?.error || 'mint-failed', message: mint.body?.message });
    const token = String(mint.body?.token ?? '');
    const claims = (() => { try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return null; } })();
    const expectSpiffeId = String(mint.body?.spiffe_id ?? '');
    const verification = await verifyOffCluster({ token, expectSpiffeId, jwksUrl: mint.body?.jwks_url });
    // the raw token IS shown (education: tokens are shown raw), but the invite key never is
    return res.json({ ok: verification.ok, token, claims, verification, serviceError: null });
  });
  api.post('/spire/test', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return res.json(await spireCtl.test()); }
    catch (e) { return res.status(500).json({ ok: false, error: 'spire_test_failed', message: 'The SPIRE check failed inside the lab.' }); }
  });
  api.post('/spire/start', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return res.json(await spireCtl.start()); }
    catch (e) { return res.status(500).json({ ok: false, error: 'spire_start_failed', message: 'Starting the local SPIRE failed.' }); }
  });
  api.post('/spire/restart', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return res.json(await spireCtl.restart()); }
    catch (e) { return res.status(500).json({ ok: false, error: 'spire_restart_failed', message: 'Restarting the local SPIRE failed.' }); }
  });


  const view = (req) => { const cfg = readConfig(env); return { cfg, app: cfg.appFor(req.body?.app) }; };
  const tokenView = (t) => ({ id: t.id, label: t.label, why: t.why, expect: t.expect, token: t.token, header: t.header, claims: t.claims });

  api.get('/info', (_req, res) => {
    const cfg = readConfig(env);
    res.set('Cache-Control', 'no-store');
    res.json({ source, realAvailable: cfg.realAvailable, realHint: cfg.realHint, version: VERSION, config: publicConfig(cfg, store, cfg.appFor(undefined)) });
  });

  // Rule 19: exactly { source: "mock"|"real" }; 409 when Real is not configured.
  api.post('/mode', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !['mock', 'real'].includes(body.source)) {
      return res.status(400).json({ error: 'bad_source', message: 'body must be exactly { source: "mock" | "real" }' });
    }
    const cfg = readConfig(env);
    if (body.source === 'real' && !cfg.realAvailable) return res.status(409).json({ error: 'real_not_configured', message: cfg.realHint, missing: cfg.missing });
    source = body.source;
    return res.json({ source });
  });

  api.post('/mint', (req, res) => {
    const { cfg, app: door } = view(req);
    res.set('Cache-Control', 'no-store');
    res.json({ source, issuedAt: new Date(now()).toISOString(), audience: cfg.audienceFor(door), tokens: mintAll({ ...cfg, audience: cfg.audienceFor(door) }, store, now()).map(tokenView) });
  });

  api.post('/present', async (req, res) => {
    const { cfg, app: door } = view(req);
    res.set('Cache-Control', 'no-store');
    if (source === 'real' && !cfg.realAvailable) return res.status(409).json({ error: 'real_not_configured', message: cfg.realHint, missing: cfg.missing });
    const audience = cfg.audienceFor(door);
    const doorUrl = cfg.doorFor(door);
    const tokens = mintAll({ ...cfg, audience }, store, now());
    const base = { source, audience, issuedAt: new Date(now()).toISOString(), tokens: tokens.map(tokenView) };
    if (source === 'mock') {
      const rows = presentMock({ doorUrl, audience, store, cfg, tokens, now: now() });
      logRun(rows);
      return res.json({ ...base, rows });
    }
    const rows = await presentReal({ doorUrl, origin: cfg.gatewayOrigin, tokens });
    logRun(rows);
    // Rule 23: a gateway that cannot be reached is a named JSON error, never a blank page or an empty 200.
    if (rows.every((r) => UNREACHABLE.has(r.error))) {
      return res.status(502).json({ ...base, rows, error: 'gateway_unreachable', message: `The gateway could not be reached: ${rows[0].words}` });
    }
    return res.json({ ...base, rows });
  });

  // The record of the newest run made in the current mode (null with a message when there is none). Rule 23: a failure is {error, message} JSON.
  api.get('/run-observability', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const run = runs.latest(source);
    if (!run) return res.json({ record: null, message: NO_RUN[source] });
    try { return res.json({ record: await buildRunRecord({ run, clock: now }) }); } catch (e) {
      const known = e instanceof RunObsError;
      console.error('run-observability:', known ? e.code : 'unexpected', known ? e.message : String(e?.message).slice(0, 200));
      return res.status(known ? e.status : 500).json({ error: known ? e.code : 'run_observability_failed', message: known ? e.message : 'The run record could not be built inside the lab.' });
    }
  });

  api.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use('/api', api);
  // Errors become short JSON. Express's default handler would send an HTML stack trace with absolute file paths.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = Number(err?.status || err?.statusCode);
    if (status === 413) return res.status(413).json({ error: 'payload_too_large' });
    if (status >= 400 && status < 500) return res.status(status).json({ error: 'bad_request' });
    return res.status(500).json({ error: 'internal_error' });
  });

  if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
    app.use(express.static(WEB_DIST));
    app.get(/^\/(?!api\/|\.well-known\/).*/, (_req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
  }
  return app;
}

export function startHttpServer({ port, host, app }) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}/` }));
    server.once('error', reject);
  });
}
