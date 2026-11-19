import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MAX_LIFETIME_SEC, UNTRUSTED_ISSUER, decode, mintAll, verify } from '../src/svid.js';
import { readConfig } from '../src/config.js';
import { baseEnv, tmpStore } from './helpers.js';

const AUD = 'https://gateway.example/door/mcp';
const cfgOf = (extra = {}) => ({ ...readConfig(baseEnv({ PUBLIC_URL: 'https://issuer.example', ...extra })), audience: AUD });
const byId = (tokens) => Object.fromEntries(tokens.map((t) => [t.id, t]));

// An independent check that does not use verify(): the signature alone, against a JWK taken from the PUBLISHED key set.
function signatureHolds(token, jwk) {
  const [h, p, s] = token.split('.');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const alg = decode(token).header.alg;
  const data = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s, 'base64url');
  return alg === 'RS256' ? crypto.verify('sha256', data, key, sig) : crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
}

for (const alg of ['RS256', 'ES256']) {
  test(`${alg}: the three tokens verify or fail as designed against the published JWKS`, () => {
    const store = tmpStore(alg);
    const cfg = cfgOf({ SPIFFE_ALG: alg });
    const t = byId(mintAll(cfg, store));
    const jwks = store.jwks();
    const ctx = { jwks, issuer: cfg.issuer, audience: AUD, subject: cfg.validSub };

    assert.deepEqual(verify(t.valid.token, ctx), { ok: true });
    assert.equal(signatureHolds(t.valid.token, jwks.keys[0]), true);

    // mismatched: the signature is good (same key), the SPIFFE ID is not
    assert.equal(signatureHolds(t.mismatched.token, jwks.keys[0]), true);
    assert.equal(verify(t.mismatched.token, ctx).reason, 'subject mismatch');
    assert.notEqual(t.mismatched.claims.sub, t.valid.claims.sub);
    assert.equal(t.mismatched.claims.iss, t.valid.claims.iss);

    // untrusted: the valid SPIFFE ID, signed by a key that is not in the published set
    assert.equal(t.untrusted.claims.sub, t.valid.claims.sub);
    assert.equal(signatureHolds(t.untrusted.token, jwks.keys[0]), false);
    assert.equal(jwks.keys.some((k) => k.kid === t.untrusted.header.kid), false);
    assert.match(verify(t.untrusted.token, ctx).reason, /not in the issuer's JWKS/);
    // even if an attacker claims the published kid, the signature fails
    const forged = decode(t.untrusted.token);
    const [, p, s] = t.untrusted.token.split('.');
    const claimsKid = `${Buffer.from(JSON.stringify({ ...forged.header, kid: store.trusted.kid })).toString('base64url')}.${p}.${s}`;
    assert.match(verify(claimsKid, ctx).reason, /signature does not verify/);
  });
}

test('headers and claims are the JWT-SVID shape: kid, sub as a SPIFFE ID, aud, exp, iat', () => {
  const store = tmpStore();
  const cfg = cfgOf({ SPIFFE_TRUST_DOMAIN: 'td.example', SPIFFE_NAMESPACE: 'ns1', SPIFFE_AGENT: 'agent-a', SPIFFE_OTHER_AGENT: 'agent-b' });
  const t = byId(mintAll(cfg, store));
  assert.equal(t.valid.claims.sub, 'spiffe://td.example/ns/ns1/sa/agent-a');
  assert.equal(t.mismatched.claims.sub, 'spiffe://td.example/ns/ns1/sa/agent-b');
  assert.equal(t.valid.claims.aud, AUD);
  assert.equal(t.valid.claims.iss, 'https://issuer.example');
  assert.equal(t.valid.header.kid, store.trusted.kid);
  assert.equal(t.untrusted.header.kid, store.untrusted.kid);
  assert.deepEqual(Object.keys(t.valid.claims).sort(), ['aud', 'exp', 'iat', 'iss', 'sub']);
});

test('token lifetime is capped at 300 seconds, whatever is asked', () => {
  const store = tmpStore();
  for (const ttl of [1, 120, 300, 301, 100000]) {
    const cfg = cfgOf({ SPIFFE_TTL_SECONDS: String(ttl) });
    for (const t of mintAll(cfg, store)) assert.ok(t.claims.exp - t.claims.iat <= MAX_LIFETIME_SEC, `ttl ${ttl}`);
  }
  assert.equal(cfgOf({ SPIFFE_TTL_SECONDS: '900' }).ttlClamped, true);
  // a token minted with a longer lifetime is refused by the verifier too
  const long = mintAll({ ...cfgOf(), ttlSeconds: 120 }, store)[0];
  const [h, , s] = long.token.split('.');
  const stretched = `${h}.${Buffer.from(JSON.stringify({ ...long.claims, exp: long.claims.iat + 3600 })).toString('base64url')}.${s}`;
  assert.ok(!verify(stretched, { jwks: store.jwks(), issuer: long.claims.iss, audience: AUD, subject: long.claims.sub }).ok);
});

test('the verifier refuses an expired token, a wrong audience, alg none and an altered payload', () => {
  const store = tmpStore();
  const cfg = cfgOf();
  const v = mintAll(cfg, store, Date.now())[0];
  const ctx = { jwks: store.jwks(), issuer: cfg.issuer, audience: AUD, subject: cfg.validSub };
  assert.equal(verify(v.token, { ...ctx, now: Date.now() + 1000 * 1000 }).reason, 'token expired');
  assert.equal(verify(v.token, { ...ctx, audience: 'https://gateway.example/other/mcp' }).reason, 'audience mismatch');
  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${v.token.split('.')[1]}.`;
  assert.match(verify(none, ctx).reason, /unsupported algorithm/);
  const [h, , s] = v.token.split('.');
  const altered = `${h}.${Buffer.from(JSON.stringify({ ...v.claims, sub: 'spiffe://evil.example/x' })).toString('base64url')}.${s}`;
  assert.match(verify(altered, ctx).reason, /signature does not verify/);
  assert.equal(verify('not.a.jwt', ctx).ok, false);
});

test('SPIFFE_AUD_ARRAY sends aud as an array and the verifier still accepts it; SPIFFE_UNTRUSTED=issuer changes iss', () => {
  const store = tmpStore();
  const cfg = cfgOf({ SPIFFE_AUD_ARRAY: '1', SPIFFE_UNTRUSTED: 'issuer' });
  const t = byId(mintAll(cfg, store));
  assert.deepEqual(t.valid.claims.aud, [AUD]);
  assert.ok(verify(t.valid.token, { jwks: store.jwks(), issuer: cfg.issuer, audience: AUD, subject: cfg.validSub }).ok);
  assert.equal(t.untrusted.claims.iss, UNTRUSTED_ISSUER);
  assert.match(verify(t.untrusted.token, { jwks: store.jwks(), issuer: cfg.issuer, audience: AUD, subject: cfg.validSub }).reason, /unknown issuer/);
});
