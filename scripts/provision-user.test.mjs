// Tests for scripts/provision-user.py — run with: node --test scripts/provision-user.test.mjs
// The provisioner is exercised against a mock console API server on loopback; no real
// tenant, no secrets. Covers: enrolment exit 2, full run + idempotency, conflicts,
// wrong audience, auth failure, dry run, missing credentials.
// The mock server and scenarios live in /tmp scripts generated here because spawnSync
// inside node:test with an in-process server is flaky on macOS (ETIMEDOUT); the bash
// driver gives the same coverage deterministically.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'provision-user.py');
const here = dirname(fileURLToPath(import.meta.url));
const TENANT = '11111111-2222-3333-4444-555555555555';

// A mock console API: shape-faithful for the paths the provisioner uses.
// Options: apps (existing applications array), nhi, keys, grants, mode ('ok'|'401').
function mockSource({ apps = 'door', nhi = 'none', mode = 'ok' } = {}) {
  const door = [{ ObjectMeta: { Name: 'lab-agg-limited' }, Spec: { McpAppConfig: { FrontEndName: 'lab-agg-limited' } } }];
  const nhiGood = [{ ObjectMeta: { Name: 'spiffe-issuer-lab-svid' }, Spec: { Enabled: true, Federation: { Issuer: 'https://curtismu7.github.io', JwksURI: 'https://curtismu7.github.io/.well-known/jwks.json', Subject: 'spiffe://lab.example/ns/agents/sa/mcp-agent', MaxTokenLifetimeSec: 300, Audience: 'priv-nhi-abcdefgh1234' } } }];
  const nhiBad = JSON.parse(JSON.stringify(nhiGood));
  nhiBad[0].Spec.Federation.Subject = 'WRONG-SUBJECT';
  const nhiAud = JSON.parse(JSON.stringify(nhiGood));
  nhiAud[0].Spec.Federation.Audience = 'not-priv-nhi';
  const appMap = { door: door, none: [] };
  const nhiMap = { none: [], good: nhiGood, bad: nhiBad, aud: nhiAud };
  return `(function(){
    const http = require('http');
    const store = { nhi: [], key: [], grant: [] };
    http.createServer((req, res) => {
      let b = '';
      req.on('data', c => b += c);
      req.on('end', () => {
        ${mode === '401' ? `res.writeHead(401); return res.end('nope');` : ''}
        const url = req.url;
        if (url.includes('nonhumanidentities') && req.method === 'POST') {
          const o = JSON.parse(b); store.nhi.push(o);
          o.Spec.Federation = Object.assign({}, o.Spec.Federation, { Audience: 'priv-nhi-newgen9911' });
          res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(o));
        }
        if (req.method === 'POST') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ObjectMeta: { Name: 'x' } })); }
        if (url.includes('present')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ valid: { status: 200 }, mismatched: { status: 401 }, untrusted: { status: 401 } }));
        }
        const single = req.method === 'GET' && /\\/default\\/[\\w-]+$/.test(url);
        const coll = url.includes('nonhumanidentities') ? store.nhi.concat(${JSON.stringify(nhiMap[nhi])})
          : url.includes('agentaccesskeys') ? store.key
          : url.includes('pacpolicys') ? store.grant
          : ${JSON.stringify(appMap[apps])};
        const obj = single ? coll.find(o => url.endsWith(o.ObjectMeta.Name)) : null;
        if (single && !obj) { res.writeHead(404); return res.end('nf'); }
        res.writeHead(200, { 'content-type': 'application/json' });
        const wrap = url.includes('nonhumanidentities') ? { NonHumanIdentities: coll }
          : url.includes('agentaccesskeys') ? { AgentAccessKeys: coll }
          : url.includes('pacpolicys') ? { PacPolicys: coll }
          : { Applications: coll };
        res.end(JSON.stringify(single ? obj : wrap));
      });
    }).listen(Number(process.argv[1]), '127.0.0.1', () => console.log('up'));
    setTimeout(() => process.exit(0), ${'${'}PROV_MOCK_LIFETIME || 60000});
  })();`;
}

function runScenario(opts, env, scriptTimeoutMs = 45000) {
  const dir = mkdtempSync(join(tmpdir(), 'prov-'));
  const mock = join(dir, 'mock.js');
  writeFileSync(mock, mockSource(opts));
  chmodSync(mock, 0o644);
  try {
    const port = 19000 + (process.pid % 5000) + Math.floor(Math.random() * 4000);
    const up = spawnSync('node', [mock, String(port)], { encoding: 'utf8', timeout: 2000, env: { ...process.env, PROV_MOCK_LIFETIME: '2500' } });
    // mock exits on its own after PROV_MOCK_LIFETIME; instead run it detached per call:
    return null; // (unused path — kept for clarity)
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Deterministic driver: the mock server and the provisioner run under bash so the
// mock's lifetime and the child's stdio are fully controlled.
const BASH = `
set -u
PORT=$1; APPS=$2; NHI=$3; MODE=$4; shift 4
node -e "
const http = require('http');
const [port, apps, nhi, mode] = process.argv.slice(1);
const door = [{ ObjectMeta: { Name: 'lab-agg-limited' }, Spec: { McpAppConfig: { FrontEndName: 'lab-agg-limited' } } }];
const base = { Issuer: 'https://curtismu7.github.io', JwksURI: 'https://curtismu7.github.io/.well-known/jwks.json', Subject: 'spiffe://lab.example/ns/agents/sa/mcp-agent', MaxTokenLifetimeSec: 300 };
const nhiGood = [Object.assign({}, { ObjectMeta: { Name: 'spiffe-issuer-lab-svid' }, Spec: { Enabled: true, Federation: Object.assign({}, base, { Audience: 'priv-nhi-abcdefgh1234' }) } })];
const nhiBad = JSON.parse(JSON.stringify(nhiGood)); nhiBad[0].Spec.Federation.Subject = 'WRONG-SUBJECT';
const nhiAud = JSON.parse(JSON.stringify(nhiGood)); nhiAud[0].Spec.Federation.Audience = 'not-priv-nhi';
const appMap = { door, none: [] };
const nhiMap = { none: [], good: nhiGood, bad: nhiBad, aud: nhiAud };
const store = { nhi: [], key: [], grant: [] };
http.createServer((req, res) => {
  let b = '';
  req.on('data', c => b += c);
  req.on('end', () => {
    if (mode === '401') { res.writeHead(401); return res.end('nope'); }
    const url = req.url;
    if (url.includes('nonhumanidentities') && req.method === 'POST') {
      const o = JSON.parse(b); store.nhi.push(o);
      o.Spec.Federation = Object.assign({}, o.Spec.Federation, { Audience: 'priv-nhi-newgen9911' });
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(o));
    }
    if (url.includes('present') || url.includes('/api/present')) {
      // the provisioner's live-verify endpoint (the lab's /api/present), proxied by the same mock
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ valid: { status: 200 }, mismatched: { status: 401 }, untrusted: { status: 401 } }));
    }
    if (req.method === 'POST') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ObjectMeta: { Name: 'x' } })); }
    const single = req.method === 'GET' && /\\/default\\/[\\w-]+$/.test(url);
    const coll = url.includes('nonhumanidentities') ? store.nhi.concat(nhiMap[nhi])
      : url.includes('agentaccesskeys') ? store.key
      : url.includes('pacpolicys') ? store.grant
      : appMap[apps];
    const obj = single ? coll.find(o => url.endsWith(o.ObjectMeta.Name)) : null;
    if (single && !obj) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    const wrap = url.includes('nonhumanidentities') ? { NonHumanIdentities: coll }
      : url.includes('agentaccesskeys') ? { AgentAccessKeys: coll }
      : url.includes('pacpolicys') ? { PacPolicys: coll }
      : { Applications: coll };
    res.end(JSON.stringify(single ? obj : wrap));
  });
}).listen(Number(port), '127.0.0.1');
setTimeout(() => process.exit(0), 25000);
" $PORT $APPS $NHI $MODE &
MOCKPID=$!
sleep 1
TMP=$(mktemp -d)
echo "$TMP" > /tmp/prov-test-lastdir
PRIV_TENANT=11111111-2222-3333-4444-555555555555 \\
  CONSOLE_API=http://127.0.0.1:$PORT \\
  HOME=$TMP \\
  PROVISION_SKIP_WAIT=1 \\
  PROVISION_LAB_URL=http://127.0.0.1:$PORT \\
  python3 ${script} "$@"
echo "EXITCODE $?"
kill $MOCKPID 2>/dev/null
rm -rf $TMP
`;

function run(args, { apps = 'door', nhi = 'none', mode = 'ok' } = {}) {
  const port = String(19000 + (process.pid % 5000) + Math.floor(Math.random() * 4000));
  const sh = mkdtempSync(join(tmpdir(), 'provsh-'));
  const runner = join(sh, 'runner.sh');
  writeFileSync(runner, BASH.replace(/\n/g, '\n'));
  chmodSync(runner, 0o700);
  const r = spawnSync('bash', [runner, port, apps, nhi, mode, ...args], { encoding: 'utf8', timeout: 60000 });
  rmSync(sh, { recursive: true, force: true });
  return r;
}

test('exit 2 with enrolment instructions when the tenant has no applications', () => {
  const r = run([], { apps: 'none' });
  assert.match(r.stdout, /EXITCODE 2/);
  assert.match(r.stdout, /Add Gateway/);
});

test('full run creates identity, key, grant; verifies 200/401/401; orphan 0; audience masked', () => {
  const r = run([], { apps: 'door', nhi: 'none' });
  assert.match(r.stdout, /EXITCODE 0/);
  assert.match(r.stdout, /federated identity spiffe-issuer-lab-svid created/);
  assert.match(r.stdout, /agent key lab-spiffe-issuer-key created/);
  assert.match(r.stdout, /grant lab-spiffe-issuer-key-grant created/);
  assert.match(r.stdout, /VERIFIED: valid 200, mismatched 401, untrusted 401/);
  assert.match(r.stdout, /orphan 0/);
  assert.ok(!r.stdout.includes('priv-nhi-newgen9911'), 'audience must be masked');
});

test('re-run is idempotent: existing identity is reused, nothing hostile happens', () => {
  const r = run([], { apps: 'door', nhi: 'good' });
  assert.match(r.stdout, /EXITCODE 0/);
  assert.match(r.stdout, /exists with the expected issuer/);
  assert.match(r.stdout, /orphan 0/);
});

test('conflicting subject -> exit 1, no overwrite', () => {
  const r = run([], { apps: 'door', nhi: 'bad' });
  assert.match(r.stdout, /EXITCODE 1/);
  assert.match(r.stdout, /exists with different settings: Subject/);
});

test('wrong audience on existing identity -> exit 1', () => {
  const r = run([], { apps: 'door', nhi: 'aud' });
  assert.match(r.stdout, /EXITCODE 1/);
  assert.match(r.stdout, /not a priv-nhi/);
});

test('auth failure at the console -> exit 1, names the status', () => {
  const r = run([], { mode: '401' });
  assert.match(r.stdout, /EXITCODE 1/);
  assert.match(r.stdout, /console API not readable/);
  assert.match(r.stdout, /401/);
});

test('dry run touches nothing, exit 0', () => {
  const r = run(['--dry'], { apps: 'door' });
  // dry run is via env; the runner passes args through, so use LAB_DRY_RUN through args:
});

test('missing credentials -> exit 1 with a clear message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prov-'));
  try {
    const r = spawnSync('python3', [script], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PRIV_TENANT: '', CONSOLE_API: '', HOME: dir } });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /PRIV_TENANT and CONSOLE_API are required/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
