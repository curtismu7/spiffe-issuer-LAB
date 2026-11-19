// "SPIRE server control": test, start and restart an optional LOCAL SPIRE server container.
// The lab itself is a token minter, not SPIRE; this card is education: it shows what a real SPIRE
// deployment would look like and lets the user run one on loopback with Docker.
// Safety: execFile with a fixed arg array (never a shell string), only the exact container name and
// image tag below, published on 127.0.0.1 only, stderr summarized (host paths stripped).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { setAllowedOrigins } from './netguard.js';
import { cleanOrigin } from './config.js';

export const CONTAINER_NAME = 'spire-demo-server';
export const SPIRE_IMAGE = 'ghcr.io/spiffe/spire-server:1.7.2';
export const LOCAL_PORT = 18081;
const TRUST_DOMAIN = 'demo.spiffe';
const TIMEOUT_MS = 5000;

// A minimal SPIRE server config: join-token node attestation, disk keys, sqlite store. No secrets.
export function serverConfText() {
  return [
    'server {',
    '    bind_address = "127.0.0.1"',
    '    bind_port = "8080"',
    '    socket_path = "/tmp/spire-server/private/api.sock"',
    `    trust_domain = "${TRUST_DOMAIN}"`,
    '    data_dir = "/opt/spire/data"',
    '    log_level = "INFO"',
    '    default_svid_ttl = "1h"',
    '    ca_subject = { country = "US", organization = "SPIFFE LAB", common_name = "SPIRE demo" }',
    '}',
    'plugins {',
    '    DataStore "sql" { plugin_data { database_type = "sqlite3" connection_string = "/opt/spire/data/datastore.sqlite3" } }',
    '    NodeAttestor "join_token" { plugin_data {} }',
    '    KeyManager "disk" { plugin_data { keys_path = "/opt/spire/data/keys.json" } }',
    '}',
    'health_checks {',
    '    listener_enabled = true',
    '    bind_address = "0.0.0.0"',
    '    bind_port = "8081"',
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

// Settings: SPIRE_SERVER_URL / SPIRE_AGENT_URL / SPIRE_ALLOWED_HOSTS. Unset server URL means LOCAL.
export function parseSpireSettings(env = process.env) {
  const problems = [];
  const origin = (k) => {
    const raw = String(env[k] ?? '').trim();
    if (!raw) return null;
    const o = cleanOrigin(raw);
    if (!o) problems.push(`${k} must be an https origin with no path (http only on loopback)`);
    return o;
  };
  const serverUrl = origin('SPIRE_SERVER_URL');
  const agentUrl = origin('SPIRE_AGENT_URL');
  const allowedOrigins = String(env.SPIRE_ALLOWED_HOSTS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((raw) => { const o = cleanOrigin(raw); if (!o) problems.push(`SPIRE_ALLOWED_HOSTS entries must be https origins (http only on loopback): ${raw}`); return o; })
    .filter(Boolean);
  return { mode: serverUrl ? 'remote' : 'local', serverUrl, agentUrl, allowedOrigins, problems };
}

// A named outbound error, never a raw stack with host paths (rule 23 and the no-paths rule).
const summarize = (err) => String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 200);

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

// Is a loopback port accepting TCP? Loopback only: the netguard allows this and nothing else.
function probePort(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('error', () => done(false));
    s.connect(port, host, () => done(true));
  });
}

// docker inspect -f: exit 0 + the name means the container exists; Running tells us its state.
async function containerRunning(run) {
  try {
    const { stdout } = await run('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER_NAME]);
    return String(stdout).trim() === 'true';
  } catch { return false; }
}

export function createSpireControl({
  env = process.env, dataDir, run = promisify(execFile), fetchImpl = fetch, probe = probePort, now = () => new Date(),
} = {}) {
  const confDir = path.join(dataDir, 'spire');

  // The remote probe may only touch the configured origins plus the allowlist (netguard pattern:
  // allow exactly these for the duration of the call, then reset).
  const withGuard = async (origins, fn) => {
    setAllowedOrigins(origins);
    try { return await fn(); } finally { setAllowedOrigins([]); }
  };

  async function test() {
    const settings = parseSpireSettings(env);
    const checks = [];
    let tested = settings.mode;

    if (settings.mode === 'remote') {
      const base = settings.serverUrl;
      let jwksUri = null;
      checks.push(await withTime('discovery', () => withGuard([base, ...settings.allowedOrigins], async () => {
        const r = await timedFetch(`${base}/.well-known/openid-configuration`, { fetchImpl });
        const doc = await r.json().catch(() => null);
        if (r.status !== 200 || !doc || typeof doc !== 'object') return { ok: false, detail: `discovery returned HTTP ${r.status}, not a JSON document` };
        if (typeof doc.jwks_uri !== 'string' || !doc.jwks_uri) return { ok: false, detail: 'discovery document has no jwks_uri' };
        jwksUri = doc.jwks_uri;
        return { ok: true, detail: `HTTP 200, jwks_uri present` };
      })));
      checks.push(await withTime('jwks', async () => {
        if (!jwksUri) return { ok: false, detail: 'skipped: discovery did not yield a jwks_uri' };
        let origin;
        try { origin = new URL(jwksUri).origin; } catch { return { ok: false, detail: 'jwks_uri is not a URL' }; }
        if (origin !== base && !settings.allowedOrigins.includes(origin)) return { ok: false, detail: 'jwks_uri is outside the configured origins (add it to SPIRE_ALLOWED_HOSTS)' };
        return withGuard([origin], async () => {
          const r = await timedFetch(jwksUri, { fetchImpl });
          const doc = await r.json().catch(() => null);
          if (r.status !== 200 || !doc || !Array.isArray(doc.keys)) return { ok: false, detail: `JWKS returned HTTP ${r.status}, not a JSON key set` };
          if (!doc.keys.length) return { ok: false, detail: 'JWKS has an empty keys array' };
          return { ok: true, detail: `HTTP 200, ${doc.keys.length} key${doc.keys.length === 1 ? '' : 's'}` };
        });
      }));
      if (settings.agentUrl) {
        const agent = settings.agentUrl;
        checks.push(await withTime('agent', () => withGuard([agent], async () => {
          const r = await timedFetch(agent, { fetchImpl });
          return { ok: true, detail: `reachable: answered HTTP ${r.status}` };
        })));
      } else {
        checks.push({ name: 'agent', ok: false, detail: 'not configured (SPIRE_AGENT_URL is unset)', ms: 0 });
      }
    } else {
      tested = 'local';
      checks.push(await withTime('container', async () => {
        const running = await containerRunning(run);
        return { ok: running, detail: running ? `${CONTAINER_NAME} is running` : `${CONTAINER_NAME} is not running (Docker may be unavailable)` };
      }));
      checks.push(await withTime('api-port', async () => {
        const open = await probe(LOCAL_PORT);
        return { ok: open, detail: open ? `127.0.0.1:${LOCAL_PORT} accepts connections` : `127.0.0.1:${LOCAL_PORT} is not accepting connections` };
      }));
    }
    return { ok: checks.every((c) => c.ok), tested, testedAt: now().toISOString(), checks };
  }

  async function dockerAvailable() {
    try { await run('docker', ['info', '--format', '{{.ServerVersion}}']); return true; } catch { return false; }
  }

  async function start() {
    if (!(await dockerAvailable())) {
      return { ok: false, reason: 'docker-unavailable', message: 'Docker is not reachable from the lab, so no local SPIRE can be started. The lab keeps minting its own test tokens.' };
    }
    fs.mkdirSync(confDir, { recursive: true });
    fs.writeFileSync(path.join(confDir, 'server.conf'), serverConfText());
    await run('docker', ['rm', '-f', CONTAINER_NAME]).catch(() => {}); // idempotent: replace any old one
    await run('docker', dockerRunArgs({ confDir }));
    const testResult = await test();
    return { ok: testResult.ok, started: true, test: testResult };
  }

  async function restart() {
    if (!(await dockerAvailable())) {
      return { ok: false, reason: 'docker-unavailable', message: 'Docker is not reachable from the lab, so no local SPIRE can be restarted.' };
    }
    await run('docker', ['rm', '-f', CONTAINER_NAME]).catch(() => {});
    fs.mkdirSync(confDir, { recursive: true });
    fs.writeFileSync(path.join(confDir, 'server.conf'), serverConfText());
    await run('docker', dockerRunArgs({ confDir }));
    const testResult = await test();
    return { ok: testResult.ok, restarted: true, test: testResult };
  }

  return { test, start, restart, confDir };
}
