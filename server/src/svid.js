// Mints three TEST JWT-SVIDs and verifies one against a JWKS. This is a token minter, not SPIRE: nothing here attests a workload.
// A JWT-SVID carries sub (the SPIFFE ID), aud, exp; iat is optional in the spec and included here.
import crypto from 'node:crypto';

export const MAX_LIFETIME_SEC = 300;
export const UNTRUSTED_ISSUER = 'https://untrusted-issuer.example';

const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

export const spiffeId = (trustDomain, namespace, agent) => `spiffe://${trustDomain}/ns/${namespace}/sa/${agent}`;

// Decode without trusting: { header, claims } or null. Display only, never a verdict.
export function decode(token) {
  try {
    const [h, p, s] = String(token).split('.');
    if (!h || !p || s === undefined) return null;
    return { header: JSON.parse(Buffer.from(h, 'base64url').toString()), claims: JSON.parse(Buffer.from(p, 'base64url').toString()) };
  } catch { return null; }
}

function sign(signer, alg, claims) {
  const input = `${b64u({ alg, typ: 'JWT', kid: signer.kid })}.${b64u(claims)}`;
  return `${input}.${signer.sign(input)}`;
}

export const KINDS = {
  valid: { label: 'Valid', why: 'Right issuer, right SPIFFE ID, right audience, signed by the published key.' },
  mismatched: { label: 'Mismatched', why: 'Right issuer and signature, but a different SPIFFE ID than the Federated Identity names.' },
  untrusted: { label: 'Untrusted', why: 'The valid SPIFFE ID, but signed by a key the issuer never published.' },
};

// cfg: { issuer, trustDomain, namespace, agent, otherAgent, audience, ttlSeconds, audArray, untrustedMode }
export function mintAll(cfg, store, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const ttl = Math.min(Math.max(Math.floor(cfg.ttlSeconds), 1), MAX_LIFETIME_SEC);
  const aud = cfg.audArray ? [cfg.audience] : cfg.audience;
  const claims = (iss, sub) => ({ iss, sub, aud, iat, exp: iat + ttl });
  const validSub = spiffeId(cfg.trustDomain, cfg.namespace, cfg.agent);
  const otherSub = spiffeId(cfg.trustDomain, cfg.namespace, cfg.otherAgent);
  const untrustedIss = cfg.untrustedMode === 'issuer' ? UNTRUSTED_ISSUER : cfg.issuer;
  const defs = [
    ['valid', store.trusted, claims(cfg.issuer, validSub)],
    ['mismatched', store.trusted, claims(cfg.issuer, otherSub)],
    ['untrusted', store.untrusted, claims(untrustedIss, validSub)],
  ];
  return defs.map(([id, signer, c]) => {
    const token = sign(signer, store.alg, c);
    const { header, claims: payload } = decode(token);
    return { id, ...KINDS[id], expect: id === 'valid' ? 200 : 401, token, header, claims: payload };
  });
}

// Verify a JWT-SVID the way a gateway's Federated Identity would: issuer, key from the issuer's JWKS, signature, audience, subject, lifetime.
// -> { ok: true } | { ok: false, reason }. jwks is the PUBLISHED key set; the unpublished key can never verify.
export function verify(token, { jwks, issuer, audience, subject, now = Date.now(), maxLifetimeSec = MAX_LIFETIME_SEC }) {
  const d = decode(token);
  if (!d) return { ok: false, reason: 'not a JWT' };
  const { header, claims } = d;
  if (claims.iss !== issuer) return { ok: false, reason: `unknown issuer: no Federated Identity trusts ${String(claims.iss).slice(0, 120)}` };
  if (header.alg !== 'RS256' && header.alg !== 'ES256') return { ok: false, reason: `unsupported algorithm ${String(header.alg).slice(0, 20)}` };
  const jwk = (jwks?.keys || []).find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: `key ${String(header.kid).slice(0, 60)} is not in the issuer's JWKS` };
  const [h, p, s] = token.split('.');
  let good = false;
  try {
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    good = header.alg === 'RS256'
      ? crypto.verify('sha256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))
      : crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  } catch { good = false; }
  if (!good) return { ok: false, reason: 'signature does not verify against the issuer\'s published key' };
  const auds = [].concat(claims.aud ?? []);
  if (!auds.includes(audience)) return { ok: false, reason: 'audience mismatch' };
  if (claims.sub !== subject) return { ok: false, reason: 'subject mismatch' };
  const t = Math.floor(now / 1000);
  if (!Number.isFinite(claims.exp) || claims.exp <= t) return { ok: false, reason: 'token expired' };
  if (Number.isFinite(claims.iat) && claims.exp - claims.iat > maxLifetimeSec) return { ok: false, reason: `lifetime longer than ${maxLifetimeSec}s` };
  return { ok: true };
}
