// "Get a demo SVID" — an optional section of the SPIRE card that mints a short-lived
// JWT-SVID from a SPIRE demo token service the lab operator points at, then verifies
// the token off-cluster the way a gateway's Federated Identity would.
// Safety: the service URL and the invite key come from the lab's settings (.env), never
// from the browser; the key is write-only here and is never echoed back, logged, or
// shown in the UI. The outbound call happens only while the button is pressed (netguard).
// Nothing in this module names any real host, key or audience: those all come from settings.
import { setAllowedOrigins } from './netguard.js';
import { cleanOrigin } from './config.js';

const TIMEOUT_MS = 8000;
const AUDIENCE_RE = /^priv-nhi-[a-z0-9]{20,40}$/;

const summarize = (err) => {
  const message = String(err?.message ?? err);
  const cause = err?.cause?.code || err?.cause?.message;
  return (cause && !message.includes(String(cause)) ? `${message} (${cause})` : message).replace(/\s+/g, ' ').slice(0, 200);
};

// Settings: SPIRE_DEMO_TOKEN_URL (the service's POST /token base, https) and SPIRE_DEMO_INVITE_KEY.
// A missing URL hides the section; a set-but-invalid URL or a missing key is reported, never guessed.
export function parseDemoSvidSettings(env = process.env) {
  const problems = [];
  const rawUrl = String(env.SPIRE_DEMO_TOKEN_URL ?? '').trim();
  let url = null;
  if (rawUrl) {
    try {
      const u = new URL(rawUrl);
      const loopback = /^(127\.|localhost$|\[::1\])/i.test(u.hostname);
      if (u.protocol !== 'https:' && !loopback) problems.push('SPIRE_DEMO_TOKEN_URL must be https (http only on loopback)');
      if (u.username || u.password || u.search || u.hash) problems.push('SPIRE_DEMO_TOKEN_URL must have no credentials, query or fragment');
      if (!problems.length) url = `${u.origin}${u.pathname.replace(/\/+$/, '')}/token`;
    } catch { problems.push('SPIRE_DEMO_TOKEN_URL is not a valid URL'); }
  }
  const rawKey = String(env.SPIRE_DEMO_INVITE_KEY ?? '').trim();
  const hasKey = rawKey.length > 0;
  if (rawUrl && !hasKey) problems.push('SPIRE_DEMO_INVITE_KEY is not set: the token service refuses requests without an invite key');
  const rawAud = String(env.SPIRE_DEMO_AUDIENCE ?? '').trim();
  let audience = null;
  if (rawUrl && !rawAud) problems.push('SPIRE_DEMO_AUDIENCE is not set: the token service mints only for a registered audience');
  else if (rawAud && AUDIENCE_RE.test(rawAud)) audience = rawAud;
  else if (rawAud) problems.push('SPIRE_DEMO_AUDIENCE must match priv-nhi-[a-z0-9]{20,40}');
  const available = Boolean(url && hasKey && audience && !problems.length);
  return { available, url, hasKey, key: hasKey ? rawKey : null, audience: audience ?? rawAud ?? null, problems };
}

// POST {audience} to the service with the invite key header. -> { ok, status, body }
export async function fetchDemoSvid({ settings, audience, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!settings?.available) return { ok: false, status: 0, body: { error: 'demo-svid-not-configured' } };
  if (typeof audience !== 'string' || !AUDIENCE_RE.test(audience)) {
    return { ok: false, status: 400, body: { error: 'bad-audience', message: 'audience must match priv-nhi-[a-z0-9]{20,40}' } };
  }
  const origin = new URL(settings.url).origin;
  setAllowedOrigins([origin]);
  try {
    const r = await fetchImpl(settings.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-invite-key': settings.key },
      body: JSON.stringify({ audience }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    let body = {};
    try { body = await r.json(); } catch { /* non-JSON */ }
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: { error: 'unreachable', message: summarize(e) } };
  }
}
// Off-cluster verification, exactly what a Privilege Federated Identity does: fetch the
// issuer's public JWKS, check signature/expiry/lifetime/subject. The audience here is the
// one the token was minted for (echoed in claims) — the caller (a real gateway) would use its own.
export async function verifyOffCluster({ token, expectSpiffeId, jwksUrl, fetchImpl = fetch, timeoutMs = TIMEOUT_MS, now = Date.now() } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail, ms: 0 });
  const d = decodeJwt(token);
  if (!d) {
    add('shape', false, 'not a JWT');
    return { ok: false, checks, claims: null };
  }
  const { header, claims } = d;
  add('shape', true, `${header.alg}, expires ${claims.exp ? new Date(claims.exp * 1000).toISOString() : '?'}`);
  const nowSec = Math.floor(now / 1000);
  add('lifetime', (claims.exp - claims.iat) <= 300 && (claims.exp - claims.iat) > 0, `${claims.exp - claims.iat}s`);
  add('expiry', Number.isFinite(claims.exp) && claims.exp > nowSec, claims.exp > nowSec ? `expires in ${claims.exp - nowSec}s` : 'expired');
  const effectiveJwks = jwksUrl || (typeof claims.iss === 'string' ? `${claims.iss.replace(/\/+$/, '')}/.well-known/jwks.json` : null);
  let jwk = null;
  try {
    const r = await fetchImpl(effectiveJwks, { signal: AbortSignal.timeout(timeoutMs) });
    const jwks = await r.json();
    jwk = (jwks.keys || []).find((k) => k.kid === header.kid) || null;
    add('keys-published', Boolean(jwk), jwk ? `kid ${header.kid} is in the issuer's JWKS` : `kid ${header.kid} not found`);
  } catch (e) {
    add('keys-published', false, summarize(e));
  }
  let sig = false;
  if (jwk) {
    try {
      const crypto = await import('node:crypto');
      const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      const [h, p, s] = token.split('.');
      // ES256 JWS signatures are raw r||s (ieee-p1363), not DER
      sig = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    } catch { sig = false; }
  }
  add('signature', sig, sig ? 'verifies against the published key' : 'does not verify');
  add('subject', claims.sub === expectSpiffeId, typeof claims.sub === 'string' ? claims.sub : '(missing)');
  return { ok: checks.every((c) => c.ok), checks, claims };
}

function decodeJwt(token) {
  if (typeof token !== 'string' || token.split('.').length !== 3) return null;
  try {
    const b64 = (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return s; };
    const header = JSON.parse(Buffer.from(b64(token.split('.')[0]), 'base64').toString('utf8'));
    const claims = JSON.parse(Buffer.from(b64(token.split('.')[1]), 'base64').toString('utf8'));
    return { header, claims };
  } catch { return null; }
}
