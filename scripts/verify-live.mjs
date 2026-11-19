// Checks a RUNNING lab from the outside, with node:crypto only (none of the lab's own verifier code): fetch the JWKS the gateway would fetch,
// mint the three tokens through the API, and verify each signature against the published keys.
//   node scripts/verify-live.mjs [lab-url] [jwks-url]      (defaults: http://127.0.0.1:7828 and <lab-url>/.well-known/jwks.json)
// Pass the PUBLIC jwks url (https://<your-public-origin>/.well-known/jwks.json) as the second argument to prove the gateway can fetch it.
// Prints verdicts only: never a token and never a key. Exit 1 when the three tokens do not behave as designed.
import crypto from 'node:crypto';

const lab = (process.argv[2] || 'http://127.0.0.1:7828').replace(/\/$/, '');
const jwksUrl = process.argv[3] || `${lab}/.well-known/jwks.json`;
const seg = (t, i) => JSON.parse(Buffer.from(t.split('.')[i], 'base64url').toString());

const jwks = await (await fetch(jwksUrl)).json();
const leaks = jwks.keys.flatMap((k) => Object.keys(k).filter((f) => ['d', 'p', 'q', 'dp', 'dq', 'qi'].includes(f)));
console.log(`JWKS ${jwksUrl}: ${jwks.keys.length} key(s), private fields: ${leaks.length ? leaks.join(',') : 'none'}`);

const minted = await (await fetch(`${lab}/api/mint`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
const verdict = (t) => {
  const header = seg(t, 0);
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return 'kid not published';
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const [h, p, s] = t.split('.');
  const data = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s, 'base64url');
  const ok = header.alg === 'ES256' ? crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig) : crypto.verify('sha256', data, key, sig);
  return ok ? 'signature verifies' : 'signature does NOT verify';
};
const want = { valid: 'signature verifies', mismatched: 'signature verifies', untrusted: 'kid not published' };
let bad = leaks.length;
for (const t of minted.tokens) {
  const c = seg(t.token, 1);
  const v = verdict(t.token);
  const lifetime = c.exp - c.iat;
  const fine = v === want[t.id] && lifetime <= 300;
  if (!fine) bad++;
  console.log(`${fine ? 'ok  ' : 'FAIL'} ${t.id.padEnd(10)} ${v.padEnd(26)} sub=${c.sub} iss=${c.iss} lifetime=${lifetime}s`);
}
process.exit(bad ? 1 : 0);
