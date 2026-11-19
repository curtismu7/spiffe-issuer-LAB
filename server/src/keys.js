// The lab's two signing keys.
//   trusted   : published in the JWKS. Signs the VALID and MISMATCHED tokens.
//   untrusted : never published, never shown. Signs the UNTRUSTED token.
// Generated at first start, persisted in DATA_DIR/keys.json (mode 600, never committed, never returned by any route or logged),
// reused on every later start so the published JWKS stays stable. RS256 by default; ES256 builds its P-256 key with createECDH +
// createPrivateKey, never the EC form of crypto.generateKeyPair (SIGABRT on Node 20, family rule).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ALGS = ['RS256', 'ES256'];
const PUBLIC_FIELDS = { RSA: ['e', 'kty', 'n'], EC: ['crv', 'kty', 'x', 'y'] };

// RFC 7638 thumbprint: the key id. Same key, same kid.
export function thumbprint(jwk) {
  const fields = PUBLIC_FIELDS[jwk.kty];
  const canonical = JSON.stringify(Object.fromEntries(fields.map((f) => [f, jwk[f]])));
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}

export function publicJwkOf(privateJwk, alg) {
  const pub = Object.fromEntries(PUBLIC_FIELDS[privateJwk.kty].map((f) => [f, privateJwk[f]]));
  return { ...pub, kid: thumbprint(privateJwk), use: 'sig', alg };
}

function newPrivateJwk(alg) {
  if (alg === 'RS256') {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const { kty, n, e, d, p, q, dp, dq, qi } = privateKey.export({ format: 'jwk' });
    return { kty, n, e, d, p, q, dp, dq, qi };
  }
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const pub = ecdh.getPublicKey(); // 04 || x || y
  return {
    kty: 'EC', crv: 'P-256',
    x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url'),
    d: Buffer.from(ecdh.getPrivateKey().toString('hex').padStart(64, '0'), 'hex').toString('base64url'), // 32 bytes, left-padded
  };
}

const validFor = (entry, alg) => {
  try {
    const jwk = entry?.privateJwk;
    if (!jwk || (alg === 'RS256') !== (jwk.kty === 'RSA')) return false;
    crypto.createPrivateKey({ key: jwk, format: 'jwk' });
    return true;
  } catch { return false; }
};

function load(file, alg) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved?.alg === alg && validFor(saved.trusted, alg) && validFor(saved.untrusted, alg)) return saved;
  } catch { /* none, unreadable or for another algorithm: make new ones */ }
  return null;
}

function save(dir, file, data) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return true;
  } catch { return false; } // read-only or unwritable: the keys live for this process only
}

function signer(privateJwk, alg) {
  const key = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
  const kid = thumbprint(privateJwk);
  const publicJwk = publicJwkOf(privateJwk, alg);
  const sign = alg === 'RS256'
    ? (input) => crypto.sign('sha256', Buffer.from(input), key).toString('base64url')
    : (input) => crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return { kid, publicJwk, sign };
}

export function createKeyStore({ dataDir, alg = 'RS256' } = {}) {
  if (!ALGS.includes(alg)) throw new Error(`SPIFFE_ALG must be one of ${ALGS.join(', ')}`);
  const dir = dataDir || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../.data');
  const file = path.join(dir, 'keys.json');
  let data = load(file, alg);
  let persisted = Boolean(data);
  let created = false;
  if (!data) {
    data = { alg, trusted: { privateJwk: newPrivateJwk(alg) }, untrusted: { privateJwk: newPrivateJwk(alg) } };
    persisted = save(dir, file, data);
    created = true;
  }
  const trusted = signer(data.trusted.privateJwk, alg);
  const untrusted = signer(data.untrusted.privateJwk, alg);
  return {
    alg, trusted, untrusted, persisted, created, file,
    // The published key set: the trusted key's PUBLIC half only.
    jwks: () => ({ keys: [trusted.publicJwk] }),
  };
}
