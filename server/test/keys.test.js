import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKeyStore, thumbprint } from '../src/keys.js';
import { tmpDir } from './helpers.js';

const PRIVATE = ['d', 'p', 'q', 'dp', 'dq', 'qi'];

test('keys are generated once, persisted with mode 600, and reused on the next start', () => {
  const dir = tmpDir();
  const a = createKeyStore({ dataDir: dir });
  assert.equal(a.created, true);
  assert.equal(a.persisted, true);
  assert.equal(fs.statSync(path.join(dir, 'keys.json')).mode & 0o777, 0o600);
  const b = createKeyStore({ dataDir: dir });
  assert.equal(b.created, false);
  assert.equal(b.trusted.kid, a.trusted.kid);
  assert.equal(b.untrusted.kid, a.untrusted.kid);
});

test('a change of algorithm makes new keys instead of loading the wrong ones', () => {
  const dir = tmpDir();
  const rsa = createKeyStore({ dataDir: dir, alg: 'RS256' });
  const ec = createKeyStore({ dataDir: dir, alg: 'ES256' });
  assert.equal(ec.created, true);
  assert.notEqual(ec.trusted.kid, rsa.trusted.kid);
  assert.equal(ec.jwks().keys[0].kty, 'EC');
});

test('a corrupt key file is replaced, an unwritable directory still works (keys last for the process)', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'keys.json'), '{not json');
  assert.equal(createKeyStore({ dataDir: dir }).created, true);
  const blocked = createKeyStore({ dataDir: '/dev/null/keys' });
  assert.equal(blocked.persisted, false);
  assert.ok(blocked.trusted.kid);
});

for (const alg of ['RS256', 'ES256']) {
  test(`${alg}: the published JWKS holds the trusted key's public half only, and the untrusted key is not in it`, () => {
    const s = createKeyStore({ dataDir: tmpDir(), alg });
    const { keys } = s.jwks();
    assert.equal(keys.length, 1);
    assert.equal(keys[0].kid, s.trusted.kid);
    assert.equal(keys[0].kid, thumbprint(keys[0]));
    assert.equal(keys[0].alg, alg);
    for (const f of PRIVATE) assert.equal(Object.hasOwn(keys[0], f), false, `JWKS leaks ${f}`);
    assert.notEqual(s.untrusted.kid, s.trusted.kid);
    assert.equal(JSON.stringify(s.jwks()).includes(s.untrusted.kid), false);
    assert.equal(s.untrusted.publicJwk.kid, s.untrusted.kid); // exists, but nothing publishes it
  });
}

test('no source file generates an EC key with crypto.generateKeyPair (family rule: createECDH)', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');
  const files = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of files(dir)) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /generateKeyPair(Sync)?\(\s*['"]ec['"]/, f);
});
