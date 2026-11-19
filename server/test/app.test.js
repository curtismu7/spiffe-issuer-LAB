import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assertTrace } from '../src/gatewayTrace.js';
import { baseEnv, rawGet, startFakeDoor, startLab, tmpStore } from './helpers.js';

const PRIVATE_MARKERS = /BEGIN (RSA |EC )?PRIVATE KEY|"(d|p|q|dp|dq|qi)"\s*:/;
const MOCK_ENV = baseEnv({ PUBLIC_URL: 'https://issuer.example' });

// Every body a route answers is scanned for private key material and for the stored private values themselves.
function privateValues(store) {
  const stored = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  return ['trusted', 'untrusted'].flatMap((w) => Object.entries(stored[w].privateJwk).filter(([k]) => ['d', 'p', 'q', 'dp', 'dq', 'qi'].includes(k)).map(([, v]) => v));
}
async function noPrivateKey(res, store) {
  const text = await res.clone().text();
  assert.doesNotMatch(text, PRIVATE_MARKERS);
  for (const v of privateValues(store)) assert.equal(text.includes(v), false, 'private key material in a response');
  return text;
}

test('starts with no settings: Mock, no Real, the page data says exactly what is missing', async () => {
  const lab = await startLab();
  const info = await (await lab.get('/api/info')).json();
  assert.equal(info.source, 'mock');
  assert.equal(info.realAvailable, false);
  assert.match(info.realHint, /Missing: SPIFFE_GW_URL, SPIFFE_GW_APPS, PUBLIC_URL/);
  assert.equal(info.config.publicUrlSet, false);
  assert.equal(info.config.issuer, 'https://spiffe-issuer.example');
  await lab.close();
});

test('Real is refused with the exact missing keys: POST /api/mode and a Real present', async () => {
  const lab = await startLab();
  const r = await lab.post('/api/mode', { source: 'real' });
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.error, 'real_not_configured');
  assert.deepEqual(body.missing, ['SPIFFE_GW_URL', 'SPIFFE_GW_APPS', 'PUBLIC_URL']);
  assert.equal((await lab.post('/api/mode', { source: 'both' })).status, 400);
  assert.equal((await lab.post('/api/mode', { source: 'mock', extra: 1 })).status, 400);
  await lab.close();
});

test('the public JWKS and the discovery document answer for ANY Host and hold public keys only', async () => {
  const lab = await startLab({ env: MOCK_ENV });
  for (const host of ['tunnel-name.example', '127.0.0.1']) {
    const j = await rawGet(lab.base, '/.well-known/jwks.json', { host });
    assert.equal(j.status, 200);
    const jwks = JSON.parse(j.body);
    assert.deepEqual(jwks, lab.store.jwks());
    assert.doesNotMatch(j.body, PRIVATE_MARKERS);
    const d = JSON.parse((await rawGet(lab.base, '/.well-known/openid-configuration', { host })).body);
    assert.equal(d.issuer, 'https://issuer.example');
    assert.equal(d.jwks_uri, 'https://issuer.example/.well-known/jwks.json');
    assert.deepEqual(d.id_token_signing_alg_values_supported, ['RS256']);
  }
  await lab.close();
});

test('everything except the two public paths refuses a foreign Host, and /api refuses a request that came through a tunnel', async () => {
  const lab = await startLab({ env: MOCK_ENV });
  for (const p of ['/api/info', '/api/health', '/']) assert.equal((await rawGet(lab.base, p, { host: 'tunnel-name.example' })).status, 403, p);
  for (const h of [{ 'x-forwarded-for': '203.0.113.9' }, { 'cf-connecting-ip': '203.0.113.9' }, { forwarded: 'for=203.0.113.9' }, { 'ngrok-skip-browser-warning': '1' }]) {
    const r = await rawGet(lab.base, '/api/info', { host: '127.0.0.1', ...h });
    assert.equal(r.status, 403, JSON.stringify(h));
    assert.equal(JSON.parse(r.body).error, 'not_for_the_internet');
  }
  assert.equal((await lab.post('/api/mint', {}, { 'x-forwarded-for': '203.0.113.9' })).status, 403);
  // a cross-origin write is refused too
  assert.equal((await lab.post('/api/mint', {}, { origin: 'https://evil.example' })).status, 403);
  await lab.close();
});

test('health is demo-health/1', async () => {
  const lab = await startLab();
  const h = await (await lab.get('/api/health')).json();
  assert.equal(h.schema, 'demo-health/1');
  assert.equal(h.demo.id, 'spiffe-issuer');
  await lab.close();
});

test('mint returns the three tokens; no API response carries private key material', async () => {
  const store = tmpStore();
  const lab = await startLab({ env: MOCK_ENV, store });
  const logs = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => logs.push(a.join(' '));
  try {
    const responses = [await lab.get('/api/info'), await lab.get('/api/health'), await lab.post('/api/mint'), await lab.post('/api/present'), await lab.get('/.well-known/jwks.json'), await lab.get('/nope')];
    const texts = await Promise.all(responses.map((r) => noPrivateKey(r, store)));
    const mint = JSON.parse(texts[2]);
    assert.deepEqual(mint.tokens.map((t) => t.id), ['valid', 'mismatched', 'untrusted']);
    assert.deepEqual(mint.tokens.map((t) => t.expect), [200, 401, 401]);
    for (const t of mint.tokens) assert.ok(t.claims.exp - t.claims.iat <= 300);
  } finally { Object.assign(console, orig); await lab.close(); }
  assert.equal(logs.filter((l) => /eyJ[\w-]{10,}\.[\w-]{10,}/.test(l)).length, 0, 'a token reached a log line');
});

test('Mock present: the rehearsal answers 200, 401, 401, labelled MOCK, traces pass assertTrace and show no full token', async () => {
  const lab = await startLab({ env: MOCK_ENV });
  const run = await (await lab.post('/api/present')).json();
  assert.equal(run.source, 'mock');
  assert.deepEqual(run.rows.map((r) => r.status), [200, 401, 401]);
  assert.deepEqual(run.rows.map((r) => r.matched), [true, true, true]);
  assert.match(run.rows[1].words, /subject mismatch/);
  assert.match(run.rows[2].words, /not in the issuer's JWKS/);
  for (const r of run.rows) {
    assert.equal(r.source, 'mock');
    assert.match(r.words, /MOCK|accepted/);
    assert.deepEqual(assertTrace(r.trace), []);
    assert.equal(new URL(r.trace.request.url).hostname, 'gateway.invalid');
    assert.doesNotMatch(JSON.stringify(r.trace), /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/);
  }
  await lab.close();
});

