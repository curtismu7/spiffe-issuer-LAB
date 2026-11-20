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
import { createSpireControl, parseSpireSettings, TargetError, K8S_COMMANDS, COMMAND_SHOWN, CONTAINER_NAME, SPIRE_IMAGE, LOCAL_PORT } from './spireControl.js';
import { buildGuide } from './spireGuide.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST || path.resolve(HERE, '../../web/dist');
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return null; } })();
const UNREACHABLE = new Set(['mcp_unreachable', 'mcp_timeout']);

export function createApp({ store, env = process.env, now = Date.now, health = createHealth(), spire } = {}) {
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
    const tokens = mintAll({ ...cfg, audience }, store, now());
    const base = { source, audience, issuedAt: new Date(now()).toISOString(), tokens: tokens.map(tokenView) };
    if (source === 'mock') {
      const doorUrl = audience;
      return res.json({ ...base, rows: presentMock({ doorUrl, store, cfg, tokens, now: now() }) });
    }
    const rows = await presentReal({ doorUrl: audience, origin: cfg.gatewayOrigin, tokens });
    // Rule 23: a gateway that cannot be reached is a named JSON error, never a blank page or an empty 200.
    if (rows.every((r) => UNREACHABLE.has(r.error))) {
      return res.status(502).json({ ...base, rows, error: 'gateway_unreachable', message: `The gateway could not be reached: ${rows[0].words}` });
    }
    return res.json({ ...base, rows });
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
