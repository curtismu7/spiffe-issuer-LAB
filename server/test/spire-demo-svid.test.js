import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDemoSvidSettings, fetchDemoSvid, verifyOffCluster } from '../src/spireDemoSvid.js';
import crypto from 'node:crypto';

const KEY = 'tokk_test-invite-key';

// P-256 keypair built via createECDH (the rulebook bans the EC keygen API: SIGABRT on some Node versions).
// createECDH gives the private scalar; build a KeyObject from the JWK via createPrivateKey.
function p256Keypair() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const pub = ecdh.getPublicKey();
  // uncompressed point 0x04 || X || Y
  const x = pub.subarray(1, 33), y = pub.subarray(33, 65);
  const jwkPub = { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url') };
  const jwkPriv = { ...jwkPub, d: ecdh.getPrivateKey().toString('base64url') };
  const keyObject = crypto.createPrivateKey({ key: jwkPriv, format: 'jwk' });
  return { keyObject, jwkPub };
}

test('settings: unset URL means the section is off', () => {
  const s = parseDemoSvidSettings({});
  assert.equal(s.available, false);
  assert.deepEqual(s.problems, []);
});

test('settings: url without key is reported, not available', () => {
  const s = parseDemoSvidSettings({ SPIRE_DEMO_TOKEN_URL: 'https://spire.example.invalid/demo' });
  assert.equal(s.available, false);
  assert.ok(s.problems.join(' ').includes('SPIRE_DEMO_INVITE_KEY'));
});

test('settings: url + key without audience is reported, not available', () => {
  const s = parseDemoSvidSettings({ SPIRE_DEMO_TOKEN_URL: 'https://spire.example.invalid/demo', SPIRE_DEMO_INVITE_KEY: KEY });
  assert.equal(s.available, false);
  assert.ok(s.problems.join(' ').includes('SPIRE_DEMO_AUDIENCE'));
});

test('settings: a malformed audience is reported', () => {
  const s = parseDemoSvidSettings({ SPIRE_DEMO_TOKEN_URL: 'https://spire.example.invalid/demo', SPIRE_DEMO_INVITE_KEY: KEY, SPIRE_DEMO_AUDIENCE: 'https://evil.example' });
  assert.equal(s.available, false);
  assert.ok(s.problems.join(' ').includes('must match priv-nhi'));
});

test('settings: set url + key + audience is available and the /token suffix is appended', () => {
  const s = parseDemoSvidSettings({ SPIRE_DEMO_TOKEN_URL: 'https://spire.example.invalid/demo/', SPIRE_DEMO_INVITE_KEY: KEY, SPIRE_DEMO_AUDIENCE: 'priv-nhi-abcdefghij0123456789' });
  assert.equal(s.available, true);
  assert.equal(s.audience, 'priv-nhi-abcdefghij0123456789');
  assert.ok(s.url.endsWith('/demo/token'));
});

test('settings: non-https url (not loopback) is rejected', () => {
  const s = parseDemoSvidSettings({ SPIRE_DEMO_TOKEN_URL: 'http://spire.example.invalid/demo', SPIRE_DEMO_INVITE_KEY: KEY });
  assert.equal(s.available, false);
  assert.ok(s.problems.join(' ').includes('https'));
});

test('fetchDemoSvid: unconfigured settings refuse locally, nothing leaves', async () => {
  const s = parseDemoSvidSettings({});
  let called = 0;
  const r = await fetchDemoSvid({ settings: s, audience: s.audience, fetchImpl: async () => { called++; return { ok: true, json: async () => ({}) }; } });
  assert.equal(r.ok, false);
  assert.equal(r.body.error, 'demo-svid-not-configured');
  assert.equal(called, 0);
});

test('fetchDemoSvid: sends the invite key header and the audience body, never logs them', async () => {
  const s = parseDemoSvidSettings({ SPIRE_DEMO_TOKEN_URL: 'https://spire.example.invalid/demo', SPIRE_DEMO_INVITE_KEY: KEY, SPIRE_DEMO_AUDIENCE: 'priv-nhi-abcdefghij0123456789' });
  let seen = null;
  const r = await fetchDemoSvid({ settings: s, audience: 'priv-nhi-abcdefghij0123456789', fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ token: 't' }) }; } });
  assert.equal(r.ok, true);
  assert.equal(seen.init.headers['x-invite-key'], KEY);
  assert.equal(JSON.parse(seen.init.body).audience, 'priv-nhi-abcdefghij0123456789');
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test('verifyOffCluster: a real ES256 token from a stub issuer verifies end to end', async () => {
  const { keyObject, jwkPub } = p256Keypair();
  const kid = 'test-kid-1';
  const b64 = (b) => Buffer.from(b).toString('base64url');
  const header = b64(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const claims = b64(JSON.stringify({ aud: ['priv-nhi-abcdefghij0123456789'], exp: now + 300, iat: now, iss: 'https://spire.example.invalid', sub: 'spiffe://demo/external' }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: keyObject, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const token = `${header}.${claims}.${sig}`;
  const r = await verifyOffCluster({ token, expectSpiffeId: 'spiffe://demo/external', fetchImpl: async () => ({ json: async () => ({ keys: [{ ...jwkPub, kid, alg: 'ES256' }] }) }) });
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.equal(r.claims.sub, 'spiffe://demo/external');
});

test('verifyOffCluster: a tampered payload fails the signature check', async () => {
  const { keyObject, jwkPub } = p256Keypair();
  const kid = 'test-kid-2';
  const b64 = (b) => Buffer.from(b).toString('base64url');
  const header = b64(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const claims = b64(JSON.stringify({ aud: ['priv-nhi-abcdefghij0123456789'], exp: now + 300, iat: now, iss: 'https://spire.example.invalid', sub: 'spiffe://demo/external' }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: keyObject, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const claims2 = b64(JSON.stringify({ aud: ['priv-nhi-abcdefghij0123456789'], exp: now + 300, iat: now, iss: 'https://spire.example.invalid', sub: 'spiffe://demo/attacker' }));
  const r = await verifyOffCluster({ token: `${header}.${claims2}.${sig}`, expectSpiffeId: 'spiffe://demo/external', fetchImpl: async () => ({ json: async () => ({ keys: [{ ...jwkPub, kid, alg: 'ES256' }] }) }) });
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.name === 'signature').ok, false);
});

test('verifyOffCluster: an expired token fails the lifetime check', async () => {
  const b64 = (b) => Buffer.from(b).toString('base64url');
  const header = b64(JSON.stringify({ alg: 'ES256', kid: 'k', typ: 'JWT' }));
  const claims = b64(JSON.stringify({ aud: ['priv-nhi-abcdefghij0123456789'], exp: 1, iat: 0, iss: 'https://spire.example.invalid', sub: 'spiffe://demo/external' }));
  const r = await verifyOffCluster({ token: `${header}.${claims}.sig`, expectSpiffeId: 'spiffe://demo/external', fetchImpl: async () => ({ json: async () => ({ keys: [] }) }) });
  assert.equal(r.checks.find((c) => c.name === 'expiry').ok, false);
  assert.equal(r.ok, false);
});

test('fetchDemoSvid: the visitor chain is forwarded as x-forwarded-for, lab secrets are not', async () => {
  const s = parseDemoSvidSettings({ SPIRE_DEMO_TOKEN_URL: 'https://spire.example.invalid/demo', SPIRE_DEMO_INVITE_KEY: KEY, SPIRE_DEMO_AUDIENCE: 'priv-nhi-abcdefghij0123456789' });
  let seen = null;
  await fetchDemoSvid({
    settings: s,
    audience: s.audience,
    forwardedFor: '203.0.113.9, 10.0.0.2',
    fetchImpl: async (_url, init) => { seen = init.headers; return { ok: true, json: async () => ({}) }; },
  });
  assert.equal(seen['x-forwarded-for'], '203.0.113.9, 10.0.0.2');
  // the invite key still travels, but only in its header
  assert.equal(seen['x-invite-key'], KEY);
});

test('fetchDemoSvid: no forwardedFor means no x-forwarded-for header is sent', async () => {
  const s = parseDemoSvidSettings({ SPIRE_DEMO_TOKEN_URL: 'https://spire.example.invalid/demo', SPIRE_DEMO_INVITE_KEY: KEY, SPIRE_DEMO_AUDIENCE: 'priv-nhi-abcdefghij0123456789' });
  let seen = null;
  await fetchDemoSvid({
    settings: s,
    audience: s.audience,
    fetchImpl: async (_url, init) => { seen = init.headers; return { ok: true, json: async () => ({}) }; },
  });
  assert.equal(seen['x-forwarded-for'], undefined);
});
