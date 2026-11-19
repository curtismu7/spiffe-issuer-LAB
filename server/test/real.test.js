import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTrace } from '../src/gatewayTrace.js';
import { installNetguard, setAllowedOrigins } from '../src/netguard.js';
import { baseEnv, startFakeDoor, startLab, tmpStore } from './helpers.js';

const SUB = 'spiffe://lab.example/ns/agents/sa/mcp-agent';
const realEnv = (doorUrl, extra = {}) => baseEnv({ PUBLIC_URL: 'https://issuer.example', SPIFFE_GW_URL: doorUrl, SPIFFE_GW_APPS: 'door,second-door', ...extra });

test('Real present against a loopback door: valid 200, mismatched 401, untrusted 401, the gateway words, a real-source trace', async () => {
  const store = tmpStore();
  const log = [];
  const door = await startFakeDoor({ store, issuer: 'https://issuer.example', subject: SUB, log });
  const lab = await startLab({ env: realEnv(door.url), store });
  const info = await (await lab.get('/api/info')).json();
  assert.equal(info.source, 'real', 'Real is the start mode when it is configured (rule 26)');
  assert.equal(info.realAvailable, true);

  const run = await (await lab.post('/api/present', { app: 'door' })).json();
  assert.equal(run.source, 'real');
  assert.equal(run.audience, `${door.url}/door/mcp`);
  assert.deepEqual(run.rows.map((r) => r.status), [200, 401, 401]);
  assert.deepEqual(run.rows.map((r) => r.matched), [true, true, true]);
  assert.match(run.rows[0].words, /accepted: tools\/list returned 1 tool \(whoami\)/);
  assert.match(run.rows[1].words, /workload token rejected: subject mismatch/);
  assert.match(run.rows[2].words, /workload token rejected: key .* is not in the issuer's JWKS/);
  for (const r of run.rows) {
    assert.equal(r.source, 'real');
    assert.deepEqual(assertTrace(r.trace), []);
    assert.equal(r.trace.source, 'real');
    assert.ok(r.trace.decisions.every((d) => d.basis !== 'checked'), 'a real trace never says checked');
    assert.doesNotMatch(JSON.stringify(r.trace), /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/, 'no full token in a trace');
    assert.doesNotMatch(JSON.stringify(r), /agent key/);
  }
  assert.equal(run.rows[0].trace.decisions[0].outcome, 'pass');
  assert.equal(run.rows[1].trace.decisions[0].outcome, 'fail');
  // the door received the three tokens as bearers, each exactly the one shown to the page
  assert.deepEqual([...new Set(log.map((l) => l.bearer))].sort(), run.tokens.map((t) => t.token).sort());
  // a second door in the list changes the audience
  const second = await (await lab.post('/api/mint', { app: 'second-door' })).json();
  assert.equal(second.audience, `${door.url}/second-door/mcp`);
  await lab.close(); await door.close();
});

test('Real against a gateway that cannot be reached: a named JSON error with the rows, never a blank or an empty 200', async () => {
  const lab = await startLab({ env: realEnv('http://127.0.0.1:1') });
  const r = await lab.post('/api/present');
  assert.equal(r.status, 502);
  const body = await r.json();
  assert.equal(body.error, 'gateway_unreachable');
  assert.match(body.message, /could not be reached/);
  assert.equal(body.rows.length, 3);
  assert.ok(body.rows.every((x) => x.status === null && x.matched === false));
  await lab.close();
});

test('switching to Mock and back to Real works at runtime when Real is configured', async () => {
  const door = await startFakeDoor({ store: tmpStore(), issuer: 'https://issuer.example', subject: SUB });
  const lab = await startLab({ env: realEnv(door.url) });
  assert.equal((await (await lab.post('/api/mode', { source: 'mock' })).json()).source, 'mock');
  assert.equal((await (await lab.get('/api/info')).json()).source, 'mock');
  assert.equal((await lab.post('/api/mode', { source: 'real' })).status, 200);
  await lab.close(); await door.close();
});

test('the settings come from the shared settings file too, and the environment wins over it', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spiffe-env-')), 'settings.env');
  fs.writeFileSync(file, 'SPIFFE_GW_URL=https://gateway.example\nSPIFFE_GW_APPS=filedoor\nSPIFFE_TRUST_DOMAIN=file.example\nOTHER_LAB_KEY=never-read\n');
  const lab = await startLab({ env: { STANDALONE_ENV: file, PUBLIC_URL: 'https://issuer.example', SPIFFE_TRUST_DOMAIN: 'env.example' } });
  const c = (await (await lab.get('/api/info')).json()).config;
  assert.equal(c.gatewayOrigin, 'https://gateway.example');
  assert.deepEqual(c.apps, ['filedoor']);
  assert.equal(c.trustDomain, 'env.example');
  assert.equal(c.audience, 'https://gateway.example/filedoor/mcp');
  assert.doesNotMatch(JSON.stringify(c), /never-read/);
  await lab.close();
});

test('netguard: while presenting, the one configured origin is allowed and nothing else; afterwards nothing is', async () => {
  const guard = installNetguard();
  try {
    const blocked = (host) => fetch(`https://${host}/`, { signal: AbortSignal.timeout(3000) }).then(() => 'reached', (e) => (/network blocked/.test(e.message) ? 'blocked' : 'passed the guard'));
    assert.equal(await blocked('gateway.invalid'), 'blocked');
    setAllowedOrigins(['https://gateway.invalid']);
    assert.equal(await blocked('other.invalid'), 'blocked');
    assert.equal(await blocked('gateway.invalid'), 'passed the guard', 'the guard let the configured origin through (DNS then fails: .invalid)');
    setAllowedOrigins([]);
    assert.equal(await blocked('gateway.invalid'), 'blocked');
  } finally { setAllowedOrigins([]); guard.restore(); }
});
