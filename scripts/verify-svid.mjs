#!/usr/bin/env node
// Checks a JWT-SVID's signature against a published key set, WITHOUT any access to the cluster that issued it.
// This is the "verify from the outside" step: it proves the public keys really verify a real token. It is not the gateway's decision.
//
//   TOKEN=<jwt> node scripts/verify-svid.mjs <jwks-url> [--iss <iss>] [--sub <spiffe-id>] [--aud <audience>]
//   <command that prints a jwt> | node scripts/verify-svid.mjs <jwks-url>
//
// The token comes from the TOKEN variable or stdin, never from an argument (arguments land in shell history). It is never printed.
// <jwks-url> must be https (http only on loopback) and is fetched once with no redirect. Exit 0: the signature verifies and every expectation
// you gave holds. Exit 1: it does not. Exit 2: bad usage.
import crypto from 'node:crypto';

const USAGE = 'usage: TOKEN=<jwt> node scripts/verify-svid.mjs <jwks-url> [--iss <iss>] [--sub <spiffe-id>] [--aud <audience>]';
const out = (s) => console.log(s);
const die = (code, msg) => { console.error(msg); process.exit(code); };

const [url, ...rest] = process.argv.slice(2);
if (!url) die(2, USAGE);
const want = {};
for (let i = 0; i < rest.length; i += 2) {
  const k = rest[i]; const v = rest[i + 1];
  if (!['--iss', '--sub', '--aud'].includes(k) || v === undefined) die(2, USAGE);
  want[k.slice(2)] = v;
}
let u;
try { u = new URL(url); } catch { die(2, `not a URL: ${url}`); }
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) || u.username || u.password) die(2, 'the key URL must be https (http only on loopback) with no credentials');

const readStdin = () => new Promise((resolve) => {
  if (process.stdin.isTTY) return resolve('');
  let t = ''; process.stdin.on('data', (c) => { t += c; }).on('end', () => resolve(t));
});
const token = (process.env.TOKEN || (await readStdin())).trim().split(/\s+/).find((x) => x.split('.').length === 3) || '';
if (!token) die(2, `no token: set TOKEN or pipe one in.\n${USAGE}`);

const parts = token.split('.');
let header; let claims;
try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { die(1, 'not a decodable JWT'); }

let jwks;
try {
  const r = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (r.status !== 200) die(1, `the key URL answered HTTP ${r.status}`);
  const text = await r.text();
  try { jwks = JSON.parse(text); } catch { die(1, 'the key URL answered HTTP 200 but not JSON (a login page, or the wrong URL?)'); }
} catch (e) { die(1, `could not fetch the keys: ${String(e.message || e).slice(0, 160)}`); }

const fails = [];
const jwk = (jwks?.keys || []).find((k) => k.kid === header.kid);
let signature = false;
if (!jwk) fails.push(`the key ${String(header.kid).slice(0, 40)} is not in the published key set`);
else if (header.alg !== 'ES256' && header.alg !== 'RS256') fails.push(`unsupported algorithm ${String(header.alg).slice(0, 20)}`);
else {
  try {
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const data = Buffer.from(`${parts[0]}.${parts[1]}`); const sig = Buffer.from(parts[2], 'base64url');
    signature = header.alg === 'ES256' ? crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig) : crypto.verify('sha256', data, key, sig);
  } catch { signature = false; }
  if (!signature) fails.push('the signature does not verify against the published key');
}
const auds = [].concat(claims.aud ?? []);
const left = Math.round(((claims.exp ?? 0) - Date.now() / 1000) / 60);
if (!Number.isFinite(claims.exp) || left < 0) fails.push('the token has expired');
if (want.iss !== undefined && claims.iss !== want.iss) fails.push('iss is not the expected value');
if (want.sub !== undefined && claims.sub !== want.sub) fails.push('sub is not the expected value');
if (want.aud !== undefined && !auds.includes(want.aud)) fails.push('aud does not include the expected value');

out(`alg=${header.alg} kid=${String(header.kid).slice(0, 12)}`);
out(`iss=${claims.iss}`);
out(`sub=${claims.sub}`);
out(`aud=${auds.join(',')}`);
out(`expires in ${left} min`);
out(`signature: ${signature ? 'VALID' : 'NOT VALID'}`);
if (fails.length) { for (const f of fails) out(`FAIL: ${f}`); process.exit(1); }
out('OK: the signature verifies against the published keys and every expectation you gave holds.');
