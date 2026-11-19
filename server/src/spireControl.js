// "SPIRE server control": test, start and restart an optional LOCAL SPIRE server container, or test a REMOTE SPIRE the user runs themselves.
// The lab itself is a token minter, not SPIRE; this card is education: it shows what a real SPIRE deployment looks like, lets the user run one
// on loopback with Docker, and checks that a SPIRE they run elsewhere publishes keys a Privilege gateway can fetch.
// Safety: execFile with a fixed arg array (never a shell string), only the exact container name and image tag below, published on 127.0.0.1
// only, stderr summarized (host paths stripped). The remote test reaches ONLY the configured origins, only while the button is pressed (netguard).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { setAllowedOrigins } from './netguard.js';
import { cleanOrigin } from './config.js';
import { isLoopbackHost } from './safety.js';

export const CONTAINER_NAME = 'spire-demo-server';
// 1.7.2 is the version known to run on the owner's cluster volume; 1.12.x crashed there ("unable to open database file"). Re-test before bumping.
export const SPIRE_IMAGE = 'ghcr.io/spiffe/spire-server:1.7.2';
export const LOCAL_PORT = 18081; // the container's HEALTH listener (8080), published on loopback only
const TRUST_DOMAIN = 'demo.spiffe';
const TIMEOUT_MS = 5000;
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'];

// A minimal SPIRE server config: join-token node attestation, disk keys, sqlite store. No secrets.
// The API listens on 8081 and the health listener on 8080, both on all interfaces INSIDE the container (Docker publishes 8080 on loopback only).
// ca_subject takes LISTS for country and organization: a scalar there crashes the server on start.
export function serverConfText() {
  return [
    'server {',
    '    bind_address = "0.0.0.0"',
    '    bind_port = "8081"',
    `    trust_domain = "${TRUST_DOMAIN}"`,
    '    data_dir = "/opt/spire/data"',
    '    log_level = "INFO"',
    '    default_x509_svid_ttl = "1h"',
    '    default_jwt_svid_ttl = "1h"',
    '    ca_subject {',
    '        country = ["US"]',
    '        organization = ["SPIFFE LAB"]',
    '        common_name = "SPIRE demo"',
    '    }',
    '}',
    'plugins {',
    '    DataStore "sql" {',
    '        plugin_data {',
    '            database_type = "sqlite3"',
    '            connection_string = "/opt/spire/data/datastore.sqlite3"',
    '        }',
    '    }',
    '    NodeAttestor "join_token" {',
    '        plugin_data {}',
    '    }',
    '    KeyManager "disk" {',
    '        plugin_data {',
    '            keys_path = "/opt/spire/data/keys.json"',
    '        }',
    '    }',
    '}',
    'health_checks {',
    '    listener_enabled = true',
    '    bind_address = "0.0.0.0"',
    '    bind_port = "8080"',
    '    live_path = "/live"',
    '    ready_path = "/ready"',
    '}',
  ].join('\n');
}

// The exact argv for docker run. The conf directory is mounted read-only; the port is loopback-only.
export function dockerRunArgs({ confDir } = {}) {
  return ['run', '-d', '--name', CONTAINER_NAME, '--restart', 'unless-stopped',
    '-p', `127.0.0.1:${LOCAL_PORT}:8080`,
    '-v', `${confDir}:/opt/spire/conf/server:ro`,
    SPIRE_IMAGE, '-config', '/opt/spire/conf/server/server.conf'];
}

// The education string shown in the UI: no host path, a placeholder instead.
export const COMMAND_SHOWN = `docker run -d --name ${CONTAINER_NAME} -p 127.0.0.1:${LOCAL_PORT}:8080 -v <data>/spire:/opt/spire/conf/server:ro ${SPIRE_IMAGE} -config /opt/spire/conf/server/server.conf`;

// A discovery base: https (http on loopback only), no credentials, query or fragment. A PATH PREFIX is allowed, because a SPIRE OIDC provider is often
// published under one on a shared host (https://spire.example/spire). Returns { origin, base } with no trailing slash, or null.
export function normalizeBase(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname)))) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  const p = u.pathname.replace(/\/+$/, '');
  if (p && !/^(\/[A-Za-z0-9._~-]+)+$/.test(p)) return null;
  return { origin: u.origin, base: `${u.origin}${p}` };
}

// Settings: SPIRE_SERVER_URL / SPIRE_AGENT_URL / SPIRE_ALLOWED_HOSTS. Unset server URL means LOCAL. A SET but invalid one is 'invalid':
// it is reported, never silently replaced by the local mode.
export function parseSpireSettings(env = process.env) {
  const problems = [];
  const rawServer = String(env.SPIRE_SERVER_URL ?? '').trim();
  const server = rawServer ? normalizeBase(rawServer) : null;
  if (rawServer && !server) problems.push('SPIRE_SERVER_URL must be an https URL with no credentials, query or fragment (http only on loopback); a path prefix such as https://spire.example/spire is fine');
  const rawAgent = String(env.SPIRE_AGENT_URL ?? '').trim();
  const agentUrl = rawAgent ? cleanOrigin(rawAgent) : null;
  if (rawAgent && !agentUrl) problems.push('SPIRE_AGENT_URL must be an https origin with no path (http only on loopback)');
  const allowedOrigins = String(env.SPIRE_ALLOWED_HOSTS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((raw) => { const o = cleanOrigin(raw); if (!o) problems.push(`SPIRE_ALLOWED_HOSTS entries must be https origins (http only on loopback): ${raw}`); return o; })
    .filter(Boolean);
  const mode = rawServer ? (server ? 'remote' : 'invalid') : 'local';
  return { mode, serverUrl: server?.base ?? null, serverOrigin: server?.origin ?? null, agentUrl, allowedOrigins, problems };
}

// A named outbound error, never a raw stack with host paths (rule 23 and the no-paths rule).
// Node's fetch reports every network failure as "fetch failed" and keeps the real reason (ECONNREFUSED, ENOTFOUND, a certificate error) in the cause.
const summarize = (err) => {
  const message = String(err?.message ?? err);
  const cause = err?.cause?.code || err?.cause?.message;
  return (cause && !message.includes(String(cause)) ? `${message} (${cause})` : message).replace(/\s+/g, ' ').slice(0, 200);
};

function timedFetch(url, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  return fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
}

const withTime = async (name, fn) => {
  const started = Date.now();
  try {
    const detail = await fn();
    return { name, ok: detail.ok, detail: detail.detail, ms: Date.now() - started };
  } catch (e) {
    return { name, ok: false, detail: summarize(e), ms: Date.now() - started };
  }
};

// docker inspect -f: exit 0 + the name means the container exists; Running tells us its state.
async function containerRunning(run) {
  try {
    const { stdout } = await run('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER_NAME]);
    return String(stdout).trim() === 'true';
  } catch { return false; }
}

// What a published JWKS must look like for a gateway to use it, and the one thing it must NEVER contain: private key material.
export function inspectJwks(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.keys)) return { ok: false, detail: 'not a JSON key set (no "keys" array)' };
  if (!doc.keys.length) return { ok: false, detail: 'the key set is empty' };
  for (const k of doc.keys) {
    const leaked = PRIVATE_JWK_MEMBERS.filter((m) => k && typeof k === 'object' && m in k);
    if (leaked.length) return { ok: false, detail: `PRIVATE key material is published in this key set (field ${leaked[0]}). Rotate the key and fix the publishing.` };
  }
  const noKid = doc.keys.filter((k) => !k || typeof k.kid !== 'string' || !k.kid).length;
  if (noKid) return { ok: false, detail: `${noKid} key${noKid === 1 ? ' has' : 's have'} no kid, so a gateway cannot pick the right one` };
  const algs = [...new Set(doc.keys.map((k) => k.alg || `${k.kty}${k.crv ? `/${k.crv}` : ''}`))].join(', ');
  return { ok: true, detail: `${doc.keys.length} key${doc.keys.length === 1 ? '' : 's'} (${algs})` };
}

export class TargetError extends Error {
  constructor(code, detail, status = 409) { super(detail); this.code = code; this.status = status; }
}

// Starting or restarting a SPIRE on Kubernetes needs cluster credentials, which this lab never holds. The card shows these instead, with placeholders.
export const K8S_COMMANDS = [
  { label: 'See the SPIRE pods', command: 'kubectl -n <namespace> get pods | grep spire' },
  { label: 'Start (scale up)', command: 'kubectl -n <namespace> scale statefulset/spire-server --replicas=1' },
  { label: 'Restart', command: 'kubectl -n <namespace> rollout restart statefulset/spire-server' },
  { label: 'Is it healthy?', command: 'kubectl -n <namespace> exec spire-server-0 -c spire-server -- /opt/spire/bin/spire-server healthcheck' },
];

export function createSpireControl({
  env = process.env, dataDir, run = promisify(execFile), fetchImpl = fetch, now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const confDir = path.join(dataDir, 'spire');

  // The remote probe may only touch the configured origins plus the allowlist (netguard pattern:
  // allow exactly these for the duration of the call, then reset).
  const withGuard = async (origins, fn) => {
    setAllowedOrigins(origins);
    try { return await fn(); } finally { setAllowedOrigins([]); }
  };

  async function testRemote(settings) {
    const base = settings.serverUrl;
    const origins = [settings.serverOrigin, ...settings.allowedOrigins];
    const checks = [];
    let discoveryJwksUri = null;
    let outsideNote = null;

    checks.push(await withTime('discovery', () => withGuard(origins, async () => {
      const r = await timedFetch(`${base}/.well-known/openid-configuration`, { fetchImpl });
      const doc = await r.json().catch(() => null);
      if (r.status !== 200 || !doc || typeof doc !== 'object') return { ok: false, detail: `discovery returned HTTP ${r.status}, not a JSON document` };
      if (typeof doc.jwks_uri === 'string' && doc.jwks_uri) discoveryJwksUri = doc.jwks_uri;
      // The discovery document's own "issuer" is the provider's, NOT necessarily the JWT iss (SPIRE derives it from its domains setting).
      const iss = typeof doc.issuer === 'string' ? doc.issuer : '(none)';
      return { ok: true, detail: `HTTP 200, issuer ${iss}, jwks_uri ${discoveryJwksUri ? 'present' : 'missing'}. This issuer is the discovery provider's: the Federated Identity needs the iss inside the tokens` };
    })));

    // Where are the keys? The discovery document's jwks_uri first (if it stays inside the configured origins), then SPIRE's default <base>/keys.
    // Behind a path-rewriting ingress the discovery jwks_uri often points at the wrong place while <base>/keys is right.
    const candidates = [];
    if (discoveryJwksUri) {
      let o = null;
      try { o = new URL(discoveryJwksUri).origin; } catch { /* not a URL */ }
      if (o && (o === settings.serverOrigin || settings.allowedOrigins.includes(o))) candidates.push({ url: discoveryJwksUri, from: 'discovery jwks_uri' });
      else outsideNote = 'the discovery jwks_uri is outside the configured origins (add its origin to SPIRE_ALLOWED_HOSTS to test it)';
    }
    if (!candidates.some((c) => c.url === `${base}/keys`)) candidates.push({ url: `${base}/keys`, from: 'default path <base>/keys' });

    checks.push(await withTime('jwks', async () => {
      const failures = [];
      for (const c of candidates) {
        const outcome = await withGuard(origins, async () => {
          try {
            const r = await timedFetch(c.url, { fetchImpl });
            const doc = await r.json().catch(() => null);
            if (r.status !== 200) return { ok: false, detail: `HTTP ${r.status}, not a JSON key set` };
            return inspectJwks(doc);
          } catch (e) { return { ok: false, detail: summarize(e) }; }
        });
        if (outcome.detail.startsWith('PRIVATE')) return outcome; // never tuck a leak behind a fallback
        if (outcome.ok) {
          const moved = discoveryJwksUri && c.url !== discoveryJwksUri ? ` Discovery's jwks_uri (${discoveryJwksUri}) is not where the keys are: use ${c.url} as the Federated Identity's JWKS URL.` : '';
          return { ok: true, detail: `${outcome.detail} at ${c.url} (${c.from}).${moved}` };
        }
        failures.push(`${c.from}: ${outcome.detail}`);
      }
      return { ok: false, detail: `${failures.join('; ')}${outsideNote ? `; ${outsideNote}` : ''}` };
    }));

    if (settings.agentUrl) {
      const agent = settings.agentUrl;
      checks.push(await withTime('agent', () => withGuard([agent], async () => {
        const r = await timedFetch(agent, { fetchImpl });
        return { ok: true, detail: `reachable: answered HTTP ${r.status}` };
      })));
    } else {
      checks.push({ name: 'agent', ok: false, detail: 'not configured (SPIRE_AGENT_URL is unset); optional', ms: 0 });
    }
    return checks;
  }

  async function testLocal() {
    const checks = [];
    checks.push(await withTime('container', async () => {
      const running = await containerRunning(run);
      return { ok: running, detail: running ? `${CONTAINER_NAME} is running` : `${CONTAINER_NAME} is not running (Docker may be unavailable)` };
    }));
    // The server's own readiness endpoint, published on loopback: it answers 200 only once the datastore, the CA and its rotator are up.
    checks.push(await withTime('ready', async () => {
      const r = await timedFetch(`http://127.0.0.1:${LOCAL_PORT}/ready`, { fetchImpl, timeoutMs: 1500 });
      return { ok: r.status === 200, detail: r.status === 200 ? `127.0.0.1:${LOCAL_PORT}/ready answered 200` : `127.0.0.1:${LOCAL_PORT}/ready answered HTTP ${r.status}` };
    }));
    return checks;
  }

  // Which SPIRE the card works on: the user's runtime choice (like the Mock/Real toggle), defaulting from the configuration: a SPIRE_SERVER_URL
  // makes "cluster" the start choice, none makes it "docker". The choice lives in memory and is gone on restart.
  let selected = null;
  const targetNow = () => selected ?? (parseSpireSettings(env).mode === 'local' ? 'docker' : 'cluster');

  function targetView() {
    const s = parseSpireSettings(env);
    const configured = s.mode === 'remote';
    return {
      target: targetNow(), serverUrl: s.serverUrl,
      options: {
        docker: { available: true },
        cluster: { available: configured, reason: configured ? null : (s.mode === 'invalid' ? s.problems.join('; ') : "SPIRE_SERVER_URL is not set in this lab's .env") },
      },
    };
  }

  function setTarget(t) {
    if (t !== 'docker' && t !== 'cluster') throw new TargetError('bad_target', "target must be 'docker' or 'cluster'", 400);
    const s = parseSpireSettings(env);
    if (t === 'cluster' && s.mode !== 'remote') {
      throw new TargetError('cluster_not_configured', `The cluster SPIRE is not configured: ${s.mode === 'invalid' ? s.problems.join('; ') : "set SPIRE_SERVER_URL in this lab's .env and restart the lab"}. The Docker demo keeps working.`);
    }
    selected = t;
    return targetView();
  }

  async function test() {
    const settings = parseSpireSettings(env);
    let checks;
    let tested;
    if (targetNow() === 'docker') {
      tested = 'local';
      checks = await testLocal();
    } else if (settings.mode === 'remote') {
      tested = 'remote';
      checks = await testRemote(settings);
    } else {
      tested = 'invalid';
      checks = [{ name: 'settings', ok: false, detail: settings.problems.length ? settings.problems.join('; ') : "SPIRE_SERVER_URL is not set in this lab's .env", ms: 0 }];
    }
    // The agent probe is optional: a missing SPIRE_AGENT_URL does not fail a remote test.
    const required = checks.filter((c) => !(c.name === 'agent' && c.detail.startsWith('not configured')));
    return { ok: required.every((c) => c.ok), tested, target: targetNow(), testedAt: now().toISOString(), checks };
  }

  async function dockerAvailable() {
    try { await run('docker', ['info', '--format', '{{.ServerVersion}}']); return true; } catch { return false; }
  }

  // Fresh container: it needs a few seconds before /ready answers, so a start waits (bounded) instead of reporting a false failure.
  async function launch() {
    fs.mkdirSync(confDir, { recursive: true });
    fs.writeFileSync(path.join(confDir, 'server.conf'), serverConfText());
    await run('docker', ['rm', '-f', CONTAINER_NAME]).catch(() => {}); // idempotent: replace any old one
    await run('docker', dockerRunArgs({ confDir }));
    let result = await test();
    for (let i = 0; i < 15 && !result.ok; i += 1) { await sleep(1000); result = await test(); }
    return result;
  }

  // A local container only makes sense for the Docker target: with the cluster selected the card tests THAT SPIRE, and starting a demo one would test the wrong thing.
  const notLocal = (verb) => (targetNow() === 'docker' ? null
    : { ok: false, reason: 'not-local', message: `The cluster SPIRE is selected. This lab holds no cluster credentials, so it will not ${verb} a SPIRE on Kubernetes: use the kubectl commands shown, or switch to Docker.` });

  async function start() {
    const nl = notLocal('start'); if (nl) return nl;
    if (!(await dockerAvailable())) {
      return { ok: false, reason: 'docker-unavailable', message: 'Docker is not reachable from the lab, so no local SPIRE can be started. The lab keeps minting its own test tokens.' };
    }
    const testResult = await launch();
    return { ok: testResult.ok, started: true, test: testResult };
  }

  async function restart() {
    const nl = notLocal('restart'); if (nl) return nl;
    if (!(await dockerAvailable())) {
      return { ok: false, reason: 'docker-unavailable', message: 'Docker is not reachable from the lab, so no local SPIRE can be restarted.' };
    }
    const testResult = await launch();
    return { ok: testResult.ok, restarted: true, test: testResult };
  }

  return { test, start, restart, confDir, targetView, setTarget };
}
