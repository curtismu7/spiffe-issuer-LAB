import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanOrigin, readConfig } from '../src/config.js';
import { allPassed, runChecks } from '../src/doctor.js';
import { assertBindAllowed, hostCheck, portProblem, resolvePort, scanHosts } from '../src/safety.js';
import { baseEnv, tmpStore } from './helpers.js';

test('defaults: reserved .example names, RS256, 120s, the placeholder issuer, Real not available', () => {
  const c = readConfig(baseEnv());
  assert.equal(c.trustDomain, 'lab.example');
  assert.equal(c.validSub, 'spiffe://lab.example/ns/agents/sa/mcp-agent');
  assert.equal(c.mismatchedSub, 'spiffe://lab.example/ns/agents/sa/other-agent');
  assert.equal(c.alg, 'RS256');
  assert.equal(c.ttlSeconds, 120);
  assert.equal(c.publicUrlSet, false);
  assert.equal(c.realAvailable, false);
  assert.deepEqual(c.problems, []);
  assert.deepEqual(scanHosts(JSON.stringify({ ...c, audienceFor: undefined, appFor: undefined })), []);
});

test('SPIFFE_AUDIENCE accepts a URL or a Privilege-generated priv-nhi audience, and refuses anything else', () => {
  const ok = (v) => readConfig(baseEnv({ SPIFFE_AUDIENCE: v })).problems.length === 0;
  assert.ok(ok('https://gw.example/app/mcp'));
  assert.ok(ok('priv-nhi-qxbvmjsjg7ubk7shrhvcd4woqnmsaiud'));
  for (const bad of ['priv-nhi-', 'priv-nhi-Upper', 'priv-nhi-x y', 'nonsense', 'priv-nhi-x/../y']) {
    assert.match(readConfig(baseEnv({ SPIFFE_AUDIENCE: bad })).problems.join(), /SPIFFE_AUDIENCE/, bad);
  }
});

test('with a priv-nhi audience the door is still the gateway URL, and the audience is the override', () => {
  const c = readConfig(baseEnv({ SPIFFE_GW_URL: 'https://gw.example', SPIFFE_GW_APPS: 'lab-agg-limited', SPIFFE_AUDIENCE: 'priv-nhi-abc123' }));
  assert.equal(c.doorFor('lab-agg-limited'), 'https://gw.example/lab-agg-limited/mcp');
  assert.equal(c.audienceFor('lab-agg-limited'), 'priv-nhi-abc123');
});

test('PUBLIC_URL and the gateway URL must be https origins (http only on loopback), no path, no credentials', () => {
  for (const ok of ['https://x.example', 'https://x.example/', 'http://127.0.0.1:9', 'http://localhost:9']) assert.ok(cleanOrigin(ok), ok);
  for (const bad of ['http://x.example', 'https://x.example/path', 'https://u:p@x.example', 'ftp://x.example', 'nonsense', 'https://x.example?q=1']) assert.equal(cleanOrigin(bad), null, bad);
  assert.match(readConfig(baseEnv({ PUBLIC_URL: 'http://x.example' })).problems.join(), /PUBLIC_URL/);
  assert.match(readConfig(baseEnv({ SPIFFE_GW_URL: 'https://gw.example/path', SPIFFE_GW_APPS: 'a' })).problems.join(), /SPIFFE_GW_URL/);
});

test('malformed settings are named, and Real stays unavailable while any is wrong', () => {
  const good = { PUBLIC_URL: 'https://i.example', SPIFFE_GW_URL: 'https://gw.example', SPIFFE_GW_APPS: 'door' };
  assert.equal(readConfig(baseEnv(good)).realAvailable, true);
  for (const [k, v, re] of [['SPIFFE_ALG', 'HS256', /SPIFFE_ALG/], ['SPIFFE_TTL_SECONDS', 'soon', /SPIFFE_TTL_SECONDS/], ['SPIFFE_AGENT', 'a/b', /SPIFFE_AGENT/], ['SPIFFE_GW_APPS', 'Bad App', /SPIFFE_GW_APPS/], ['SPIFFE_UNTRUSTED', 'maybe', /SPIFFE_UNTRUSTED/], ['SPIFFE_OTHER_AGENT', 'mcp-agent', /differ/]]) {
    const c = readConfig(baseEnv({ ...good, [k]: v }));
    assert.match(c.problems.join(), re, k);
    assert.equal(c.realAvailable, false, k);
  }
});

test('the doctor passes on a fresh store, names missing Real settings as information, and fails on bad settings', async () => {
  const checks = await runChecks({ env: baseEnv(), store: tmpStore() });
  assert.equal(allPassed(checks), true, JSON.stringify(checks.filter((c) => c.level === 'fail')));
  assert.ok(checks.find((c) => c.id === 'tokens').detail.includes('valid token verifies'));
  assert.match(checks.find((c) => c.id === 'real').detail, /SPIFFE_GW_URL/);
  const bad = await runChecks({ env: baseEnv({ SPIFFE_TTL_SECONDS: 'x' }), store: tmpStore() });
  assert.equal(allPassed(bad), false);
});

test('scanHosts finds a real host, ignores reserved and loopback names and template text', () => {
  assert.deepEqual(scanHosts('see ' + 'https://' + 'real.corp.net/x and http://a.example and http://127.0.0.1:7828/ and https://${host}/ and https://user@b.invalid:9'), ['real.corp.net']);
});

test('safety: one port, loopback bind, the Host check', () => {
  assert.equal(resolvePort({}), 7828);
  assert.match(portProblem(8080), /reserved/);
  assert.match(portProblem(7829), /allocated port/);
  assert.throws(() => assertBindAllowed('0.0.0.0', {}), /loopback only/);
  assert.equal(assertBindAllowed('0.0.0.0', { SPIFFE_BIND: '0.0.0.0' }), '0.0.0.0');
  const answer = (host, p = '/api/info') => { let out = 'next'; hostCheck({ method: 'GET', path: p, headers: { host } }, { status: () => ({ json: () => { out = 'refused'; } }) }, () => { out = 'next'; }); return out; };
  assert.equal(answer('127.0.0.1:7828'), 'next');
  assert.equal(answer('localhost'), 'next');
  assert.equal(answer('evil.example'), 'refused');
  assert.equal(answer('evil.example', '/.well-known/jwks.json'), 'next');
  assert.equal(answer('evil.example', '/.well-known/other'), 'refused');
});
