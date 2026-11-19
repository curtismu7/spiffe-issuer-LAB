import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, scanHosts } from '../server/src/safety.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex');

test('the files the standalone rules ask for are present', () => {
  for (const f of ['README.md', 'CLAUDE.md', 'LICENSE', 'CHANGELOG.md', 'Dockerfile', 'docker-compose.yml', '.env.example', '.github/workflows/ci.yml', 'docs/shelf-entry.json', 'scripts/doctor.mjs', 'scripts/check-ui-standard.sh', 'scripts/check-no-ai-attribution.sh']) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
});

test('the shelf entry is valid and portable: Tool tier, relative composeFile, the one port, health path', () => {
  const e = JSON.parse(read('docs/shelf-entry.json')).demos[0];
  assert.equal(e.id, 'spiffe-issuer');
  assert.equal(e.kind, 'Tool');
  assert.equal(e.healthPath, '/api/health');
  assert.equal(e.url, `http://127.0.0.1:${PORT}`);
  assert.ok(!path.isAbsolute(e.composeFile), 'composeFile must be relative or a placeholder');
  assert.ok(!/\/Users\//.test(JSON.stringify(e)), 'no absolute home path');
  assert.ok(e.description.length <= 300);
});

// ---- docker-compose.yml -----------------------------------------------------------------------------------------------
export function publishedPorts(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)ports:\s*$/.exec(lines[i]);
    if (!m) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const item = /^\s*-\s*["']?([^"'\s#]+)["']?/.exec(lines[j]);
      if (!item || lines[j].search(/\S/) <= m[1].length) break;
      out.push(item[1]);
    }
  }
  return out;
}

test('docker-compose.yml publishes only on 127.0.0.1, and the parser flags anything else', () => {
  const ports = publishedPorts(read('docker-compose.yml'));
  assert.ok(ports.length > 0);
  for (const p of ports) assert.match(p, /^127\.0\.0\.1:/);
  for (const bad of ['- "7828:7828"', '- "0.0.0.0:7828:7828"', '- 7828', '- "::1:7828:7828"']) {
    const found = publishedPorts(`services:\n  a:\n    ports:\n      ${bad}\n`);
    assert.equal(found.length, 1);
    assert.doesNotMatch(found[0], /^127\.0\.0\.1:/);
  }
});

test('compose and Dockerfile agree on the one port; the container is locked down, restarts, and keeps the keys on a volume (rules 18, 21)', () => {
  const compose = read('docker-compose.yml');
  const docker = read('Dockerfile');
  assert.equal(Number(/\$\{HOST_PORT:-(\d+)\}/.exec(compose)[1]), PORT);
  assert.equal(Number(/^EXPOSE (\d+)/m.exec(docker)[1]), PORT);
  assert.match(docker, /^ENV SPIFFE_BIND=0\.0\.0\.0$/m);
  assert.match(docker, /^USER node$/m);
  assert.match(compose, /restart: unless-stopped/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop: \[ALL\]/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /spiffe-issuer-data:\/data/);
  assert.match(docker, /^ENV DATA_DIR=\/data$/m);
  assert.match(read('.dockerignore'), /^\.data$/m);
  assert.match(read('.gitignore'), /^\.data\/$/m);
  assert.match(read('.gitignore'), /^\.env$/m);
});

// ---- Vendored shared files: byte for byte, pinned ---------------------------------------------------------------------
function pinned(file, wanted) {
  const found = {};
  for (const line of read(file).split('\n')) {
    const m = /^([0-9a-f]{64})\s+(\S+)/.exec(line);
    if (m) found[path.basename(m[2])] = m[1];
  }
  for (const [name, p] of Object.entries(wanted)) assert.equal(sha(p), found[name], `${p} differs from ${file} (hand-edited, or re-vendored without re-pinning)`);
}

test('rule 22: the shared TopMenu (every file) is vendored unchanged and matches top-menu.sha256', () => {
  pinned('web/src/top-menu/top-menu.sha256', { 'TopMenu.jsx': 'web/src/top-menu/TopMenu.jsx', 'top-menu.css': 'web/src/top-menu/top-menu.css' });
  assert.ok(fs.existsSync(path.join(root, 'web/src/top-menu/ReleaseNotes.jsx')), 'TopMenu imports ReleaseNotes.jsx: vendor the whole directory');
});

test('rule 24: JsonPane and its stylesheet are vendored unchanged and match their pins', () => {
  pinned('web/src/components/JsonPane.sha256', { 'JsonPane.jsx': 'web/src/components/JsonPane.jsx' });
  assert.equal(read('web/src/components/JsonPane.css.sha256').trim().split(/\s+/)[0], sha('web/src/components/JsonPane.css'));
});

test('rule 25: the shared gateway-trace files are vendored unchanged, all four pinned', () => {
  const WEB = 'web/src/gateway-trace';
  pinned(`${WEB}/gateway-trace.sha256`, { 'GatewayTrace.jsx': `${WEB}/GatewayTrace.jsx`, 'gateway-trace.css': `${WEB}/gateway-trace.css`, 'gateway-trace.test.jsx': `${WEB}/gateway-trace.test.jsx`, 'gatewayTrace.js': 'server/src/gatewayTrace.js' });
  assert.ok(!fs.existsSync(path.join(root, 'server/src/trace.js')), 'trace.js is the W3C helper name; the vendored builder is gatewayTrace.js');
});

test('the shared stylesheet matches scripts/standalone-ui.sha256', () => {
  assert.equal(read('scripts/standalone-ui.sha256').trim(), sha('web/src/standalone-ui.css'));
});

// shared/gateway-real/gatewayClient.js, vendored as server/src/gatewayReal.js. Re-vendor with cp, then update this hash.
const GATEWAY_REAL_SHA = '7a61851851445e76943f7a4c8354bb2e90cf5b10a96d5ed8bb179ca8972b56ff';
test('the shared real-hop client is vendored unchanged', () => {
  assert.equal(sha('server/src/gatewayReal.js'), GATEWAY_REAL_SHA);
});

// ---- Hygiene ----------------------------------------------------------------------------------------------------------
function walk(dir, out = []) {
  for (const name of fs.readdirSync(path.join(root, dir))) {
    if (['node_modules', 'dist', '.git', '.data', 'package-lock.json', 'repo.test.mjs'].includes(name)) continue;
    const rel = path.join(dir, name);
    if (fs.statSync(path.join(root, rel)).isDirectory()) walk(rel, out); else out.push(rel);
  }
  return out;
}

test('no shipped text names a host other than .example, .invalid, loopback, or the public docs links', () => {
  const allowed = new Set(['curtismu7.github.io', 'github.com', 'raw.githubusercontent.com', 'local.ping-devops.com']);
  const hits = [];
  for (const f of walk('.')) {
    if (/\.(png|jpe?g|ico|woff2?)$/.test(f)) continue;
    // the vendored shared files carry the family's own documentation links; they are checked by their pins, not here
    if (/(^|\/)(standalone-ui\.css|JsonPane\.(jsx|css)|TopMenu\.jsx|top-menu\.css|GatewayTrace\.jsx|gateway-trace\.(css|test\.jsx)|ReleaseNotes\.jsx|gatewayReal\.js|gatewayTrace\.js|demo-kit-conformance\.mjs)$/.test(f)) continue;
    for (const h of scanHosts(read(f))) if (!allowed.has(h) && !/(^|\.)ping-devops\.com$/.test(h)) hits.push(`${f}: ${h}`);
  }
  assert.deepEqual(hits, []);
});

test('no private key, token or secret is committed', () => {
  const hits = [];
  for (const f of walk('.')) {
    if (/\.(png|jpe?g|ico|woff2?)$/.test(f) || f.endsWith('demo-kit-conformance.mjs')) continue;
    const t = read(f);
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)) hits.push(`${f}: PEM private key`);
    if (/eyJ[\w-]{20,}\.[\w-]{20,}\.[\w-]{10,}/.test(t) && !/test\.jsx?$/.test(f)) hits.push(`${f}: a JWT`);
  }
  assert.deepEqual(hits, []);
  assert.ok(!fs.existsSync(path.join(root, '.data')) || /^\.data\/$/m.test(read('.gitignore')));
});
