import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp, startHttpServer } from '../src/app.js';
import { createKeyStore } from '../src/keys.js';
import { readConfig } from '../src/config.js';
import { verify } from '../src/svid.js';

// Settings for tests: no shared file (STANDALONE_ENV points at nothing), only .example hosts and loopback.
export const baseEnv = (extra = {}) => ({ STANDALONE_ENV: '/nonexistent/settings.env', ...extra });

export const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spiffe-lab-'));
export const tmpStore = (alg = 'RS256') => createKeyStore({ dataDir: tmpDir(), alg });

export async function startLab({ env = baseEnv(), store = tmpStore(), now } = {}) {
  const { server, url } = await startHttpServer({ port: 0, host: '127.0.0.1', app: createApp({ store, env, now }) });
  const base = url.replace(/\/$/, '');
  const call = (method, p, body, headers = {}) => fetch(`${base}${p}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { base, store, call, get: (p, h) => call('GET', p, undefined, h), post: (p, b, h) => call('POST', p, b ?? {}, h), close: () => new Promise((r) => server.close(r)) };
}

// A raw request that lets a test choose the Host header (fetch refuses to).
export function rawGet(base, p, headers) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: p, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

// A stand-in for a Privilege MCP door on loopback. It is the "gateway" of the test: it accepts a bearer only if it verifies against the
// issuer's published JWKS (the same check a Federated Identity does), and answers like the real door shape: 401 JSON, or MCP 200.
export async function startFakeDoor({ store, issuer, subject, log = [] }) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
      log.push({ method: req.method, bearer });
      const v = verify(bearer, { jwks: store.jwks(), issuer, audience: `http://${req.headers.host}${req.url}`, subject });
      if (!v.ok) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'unauthorized', message: `workload token rejected: ${v.reason}` })); }
      if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
      const msg = raw ? JSON.parse(raw) : {};
      res.setHeader('content-type', 'application/json');
      res.setHeader('mcp-session-id', 'test-session-0001');
      if (msg.id === undefined) { res.writeHead(202); return res.end(); }
      const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', serverInfo: { name: 'fake-door', version: '1' }, capabilities: {} } : { tools: [{ name: 'whoami' }] };
      res.writeHead(200); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, log, close: () => new Promise((r) => server.close(r)) };
}

export { readConfig };
