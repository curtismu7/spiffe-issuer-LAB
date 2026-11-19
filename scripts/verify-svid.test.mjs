import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { baseEnv, startLab, tmpStore } from '../server/test/helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/verify-svid.mjs');
// A well-formed but meaningless JWT, built at run time so no token-shaped literal sits in the repo (secret scanners flag those).
const fakeToken = () => [JSON.stringify({ alg: 'RS256', kid: 'not-published' }), JSON.stringify({ iss: 'nobody' }), 'unsigned'].map((s, i) => (i < 2 ? Buffer.from(s).toString('base64url') : s)).join('.');

// Runs the script as a child process (the lab's own server answers the key URL), with the token in the environment or on stdin.
function run(args, { token, stdin } = {}) {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH, ...(token ? { TOKEN: token } : {}) };
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env });
    let outText = '';
    child.stdout.on('data', (d) => { outText += d; }); child.stderr.on('data', (d) => { outText += d; });
    child.on('close', (code) => resolve({ code, out: outText }));
    if (stdin !== undefined) child.stdin.end(stdin); else child.stdin.end();
  });
}

async function withLab(alg, fn) {
  const lab = await startLab({ env: baseEnv({ PUBLIC_URL: 'https://issuer.example', SPIFFE_ALG: alg }), store: tmpStore(alg) });
  try {
    const mint = await (await lab.post('/api/mint')).json();
    const by = Object.fromEntries(mint.tokens.map((t) => [t.id, t]));
    await fn({ jwks: `${lab.base}/.well-known/jwks.json`, by });
  } finally { await lab.close(); }
}

for (const alg of ['RS256', 'ES256']) {
  test(`${alg}: a real token verifies against the published keys, with and without expectations, and the token is never printed`, async () => {
    await withLab(alg, async ({ jwks, by }) => {
      const t = by.valid;
      const r = await run([jwks, '--iss', t.claims.iss, '--sub', t.claims.sub, '--aud', [].concat(t.claims.aud)[0]], { token: t.token });
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /signature: VALID/);
      assert.match(r.out, new RegExp(`alg=${alg}`));
      assert.match(r.out, /OK: the signature verifies/);
      assert.ok(!r.out.includes(t.token), 'the token is never printed');
      assert.ok(!/eyJ[\w-]{10,}/.test(r.out), 'no token-shaped text at all');
      const piped = await run([jwks], { stdin: `${t.token}\n` });
      assert.equal(piped.code, 0, 'the token may arrive on stdin');
    });
  });
}

test('every way a token can be wrong is refused with exit 1 and a named reason', async () => {
  await withLab('RS256', async ({ jwks, by }) => {
    const good = by.valid;
    // signed with a key that is NOT in the published set
    const untrusted = await run([jwks], { token: by.untrusted.token });
    assert.equal(untrusted.code, 1);
    assert.match(untrusted.out, /not in the published key set/);
    assert.match(untrusted.out, /signature: NOT VALID/);
    // one character of the signature changed
    const [h, p, s] = good.token.split('.');
    const bad = `${h}.${p}.${s.slice(0, -2)}${s.endsWith('AA') ? 'BB' : 'AA'}`;
    const tampered = await run([jwks], { token: bad });
    assert.equal(tampered.code, 1);
    assert.match(tampered.out, /signature does not verify/);
    // claims changed under the same signature
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...good.claims, sub: 'spiffe://evil.example/x' })).toString('base64url')}.${s}`;
    const swapped = await run([jwks], { token: forged });
    assert.equal(swapped.code, 1);
    assert.match(swapped.out, /signature does not verify/);
    // a valid signature that fails an expectation
    for (const [flag, label] of [['--iss', 'iss is not'], ['--sub', 'sub is not'], ['--aud', 'aud does not']]) {
      const r = await run([jwks, flag, 'https://nobody.example/x'], { token: good.token });
      assert.equal(r.code, 1, flag);
      assert.match(r.out, new RegExp(label));
      assert.match(r.out, /signature: VALID/, 'the signature itself was fine');
    }
  });
});

test('usage errors exit 2 and name the problem: no token, no url, a bad flag, an insecure or credentialed url', async () => {
  const none = await run(['https://keys.example/keys']);
  assert.equal(none.code, 2); assert.match(none.out, /no token/);
  assert.equal((await run([], { token: 'a.b.c' })).code, 2);
  assert.equal((await run(['https://keys.example/keys', '--wat', 'x'], { token: 'a.b.c' })).code, 2);
  assert.equal((await run(['https://keys.example/keys', '--iss'], { token: 'a.b.c' })).code, 2);
  for (const bad of ['http://keys.example/keys', 'https://u:p@keys.example/keys', 'ftp://keys.example/keys', 'not a url']) {
    const r = await run([bad], { token: 'a.b.c' });
    assert.equal(r.code, 2, bad);
  }
});

test('a key URL that does not answer, answers an error, or redirects is a clean exit 1', async () => {
  const unreachable = await run(['http://127.0.0.1:1/keys'], { token: fakeToken() });
  assert.equal(unreachable.code, 1);
  assert.match(unreachable.out, /could not fetch the keys/);
  // A stub that answers whatever status/body/redirect the case needs, so the test never depends on whether the lab's web bundle was built.
  const server = http.createServer((req, res) => {
    if (req.url === '/missing') { res.writeHead(404); return res.end('no'); }
    if (req.url === '/login') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>sign in</title>'); }
    if (req.url === '/moved') { res.writeHead(302, { location: '/login' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"keys":[]}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tok = fakeToken();
  try {
    const missing = await run([`${base}/missing`], { token: tok });
    assert.equal(missing.code, 1); assert.match(missing.out, /HTTP 404/);
    const login = await run([`${base}/login`], { token: tok });
    assert.equal(login.code, 1); assert.match(login.out, /200 but not JSON/);
    const moved = await run([`${base}/moved`], { token: tok });
    assert.equal(moved.code, 1); assert.match(moved.out, /could not fetch the keys/, 'a redirect is never followed');
    const garbage = await run([`${base}/keys`], { token: 'not.a.jwt' });
    assert.equal(garbage.code, 1); assert.match(garbage.out, /not a decodable JWT/);
    const empty = await run([`${base}/keys`], { token: tok });
    assert.equal(empty.code, 1); assert.match(empty.out, /not in the published key set/);
  } finally { await new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); }
});
