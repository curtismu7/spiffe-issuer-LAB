import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSpireControl, dockerRunArgs, inspectJwks, normalizeBase, parseSpireSettings, serverConfText,
  TargetError, K8S_COMMANDS, COMMAND_SHOWN, CONTAINER_NAME, SPIRE_IMAGE, LOCAL_PORT,
} from '../src/spireControl.js';
import { baseEnv } from './helpers.js';

// A fake execFile runner: records every argv (no shell), answers per command.
function fakeRun(handler = () => ({ stdout: '' })) {
  const calls = [];
  const run = async (cmd, args) => { calls.push([cmd, ...args]); return handler(cmd, args); };
  run.calls = calls;
  return run;
}
const runningContainer = () => fakeRun((_c, args) => (args[0] === 'inspect' ? { stdout: 'true\n' } : { stdout: '27.0.3\n' }));
const stoppedContainer = () => fakeRun((_c, args) => (args[0] === 'inspect' ? { stdout: 'false\n' } : { stdout: '27.0.3\n' }));
const noSleep = async () => {};
const ready = async () => ({ status: 200, json: async () => ({}) });
const KEYS = { keys: [{ kty: 'EC', crv: 'P-256', alg: 'ES256', kid: 'k1', x: 'x', y: 'y' }] };

test('settings: unset URLs mean local; a set one must be a clean https URL (a path prefix is fine); the allowlist is parsed', () => {
  const local = parseSpireSettings(baseEnv());
  assert.equal(local.mode, 'local');
  assert.equal(local.serverUrl, null);
  assert.deepEqual(local.problems, []);

  const remote = parseSpireSettings(baseEnv({ SPIRE_SERVER_URL: 'https://spire.example', SPIRE_AGENT_URL: 'https://agent.example', SPIRE_ALLOWED_HOSTS: 'https://keys.example, https://more.example' }));
  assert.equal(remote.mode, 'remote');
  assert.equal(remote.serverUrl, 'https://spire.example');
  assert.deepEqual(remote.allowedOrigins, ['https://keys.example', 'https://more.example']);

  const prefixed = parseSpireSettings(baseEnv({ SPIRE_SERVER_URL: 'https://host.example/spire/' }));
  assert.equal(prefixed.mode, 'remote');
  assert.equal(prefixed.serverUrl, 'https://host.example/spire', 'the trailing slash is dropped, the prefix kept');
  assert.equal(prefixed.serverOrigin, 'https://host.example');
});

test('a SET but invalid SPIRE_SERVER_URL is reported as invalid, never silently replaced by the local mode', async () => {
  for (const bad of ['http://spire.example', 'https://u:p@spire.example', 'https://spire.example/a?x=1', 'https://spire.example/#f', 'not a url', 'https://spire.example/a b', 'https://spire.example//x']) {
    const s = parseSpireSettings(baseEnv({ SPIRE_SERVER_URL: bad }));
    assert.equal(s.mode, 'invalid', bad);
    assert.equal(s.problems.length, 1, bad);
  }
  const mixed = parseSpireSettings(baseEnv({ SPIRE_SERVER_URL: 'http://spire.example', SPIRE_ALLOWED_HOSTS: 'nonsense', SPIRE_AGENT_URL: 'ftp://agent.example' }));
  assert.equal(mixed.problems.length, 3, mixed.problems.join('; '));
  assert.equal(normalizeBase('http://127.0.0.1:9/spire').base, 'http://127.0.0.1:9/spire', 'loopback http is allowed');
  assert.equal(normalizeBase('https://spire.example/../x').base, 'https://spire.example/x', 'dot segments are resolved by the URL parser and cannot leave the host');

  const fetchImpl = async () => { throw new Error('no request may be made for invalid settings'); };
  const r = await createSpireControl({ env: baseEnv({ SPIRE_SERVER_URL: 'http://spire.example' }), dataDir: os.tmpdir(), fetchImpl, run: fakeRun() }).test();
  assert.equal(r.ok, false);
  assert.equal(r.tested, 'invalid');
  assert.deepEqual(r.checks.map((c) => c.name), ['settings']);
  assert.match(r.checks[0].detail, /SPIRE_SERVER_URL must be an https URL/);
});

test('command construction: a fixed argv, the exact container name and image, loopback-only publish, no shell string', async () => {
  const run = runningContainer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spire-cfg-'));
  const ctl = createSpireControl({ env: baseEnv(), dataDir: dir, run, fetchImpl: ready, sleep: noSleep });
  await ctl.start();
  const docker = run.calls.filter((c) => c[0] === 'docker');
  const runCmd = docker.find((c) => c[1] === 'run');
  assert.ok(runCmd, 'a docker run was issued');
  assert.deepEqual(runCmd.slice(3, 5), ['--name', CONTAINER_NAME]);
  assert.ok(runCmd.includes(SPIRE_IMAGE));
  assert.ok(runCmd.includes(`127.0.0.1:${LOCAL_PORT}:8080`), 'the port is published on loopback only');
  assert.equal(dockerRunArgs({ confDir: '/data/spire' }).indexOf('-p'), 6);
  const mount = runCmd.find((a) => a.startsWith('-v') === false && a.includes('/opt/spire/conf/server'));
  assert.ok(mount && mount.startsWith(path.join(dir, 'spire') + ':'), 'the conf dir is mounted from the data dir');
  assert.match(fs.readFileSync(path.join(dir, 'spire', 'server.conf'), 'utf8'), /trust_domain = "demo.spiffe"/);
  assert.match(fs.readFileSync(path.join(dir, 'spire', 'server.conf'), 'utf8'), /NodeAttestor "join_token"/);
  // The education string shows the same command with a placeholder path, never the host path.
  assert.equal(COMMAND_SHOWN, `docker run -d --name ${CONTAINER_NAME} -p 127.0.0.1:${LOCAL_PORT}:8080 -v <data>/spire:/opt/spire/conf/server:ro ${SPIRE_IMAGE} -config /opt/spire/conf/server/server.conf`);
});

test('the generated server.conf boots: ca_subject lists (a scalar crashed the server), API 8081 and health 8080 reachable through the published port', () => {
  const conf = serverConfText();
  assert.match(conf, /trust_domain = "demo.spiffe"/);
  assert.match(conf, /country = \["US"\]/);
  assert.match(conf, /organization = \["SPIFFE LAB"\]/);
  assert.doesNotMatch(conf, /ca_subject = \{/, 'the one-line object form is what made SPIRE crash on start');
  assert.match(conf, /health_checks \{[\s\S]*bind_address = "0\.0\.0\.0"[\s\S]*bind_port = "8080"[\s\S]*ready_path = "\/ready"/);
  assert.match(conf, /bind_port = "8081"/);
  assert.match(conf, /join_token/);
  assert.match(conf, /KeyManager "disk"/);
  assert.doesNotMatch(conf, /PRIVATE|password|secret/i);
});

test('local test: container + the server\'s own /ready, pass and named failures', async () => {
  const up = createSpireControl({ env: baseEnv(), dataDir: os.tmpdir(), run: runningContainer(), fetchImpl: ready, now: () => new Date(0) });
  const upResult = await up.test();
  assert.equal(upResult.ok, true);
  assert.equal(upResult.tested, 'local');
  assert.equal(upResult.testedAt, new Date(0).toISOString());
  assert.deepEqual(upResult.checks.map((c) => c.name), ['container', 'ready']);
  for (const c of upResult.checks) { assert.equal(c.ok, true, c.name); assert.equal(typeof c.ms, 'number'); assert.equal(typeof c.detail, 'string'); }
  assert.match(upResult.checks[1].detail, new RegExp(`127.0.0.1:${LOCAL_PORT}/ready answered 200`));

  const refusing = async () => { throw new Error('fetch failed: ECONNREFUSED'); };
  const down = await createSpireControl({ env: baseEnv(), dataDir: os.tmpdir(), run: stoppedContainer(), fetchImpl: refusing }).test();
  assert.equal(down.ok, false);
  assert.ok(down.checks.every((c) => c.ok === false));
  assert.match(down.checks[1].detail, /ECONNREFUSED/);

  const notReady = async () => ({ status: 503, json: async () => ({}) });
  const half = await createSpireControl({ env: baseEnv(), dataDir: os.tmpdir(), run: runningContainer(), fetchImpl: notReady }).test();
  assert.equal(half.ok, false, 'a running container that is not ready is not a pass (the old TCP check passed a crash-looping one)');
  assert.match(half.checks[1].detail, /HTTP 503/);
});

test('start waits (bounded) for the new container to become ready instead of reporting a false failure', async () => {
  let n = 0; let slept = 0;
  const fetchImpl = async () => { n += 1; return { status: n < 4 ? 503 : 200, json: async () => ({}) }; };
  const ctl = createSpireControl({ env: baseEnv(), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'spire-w-')), run: runningContainer(), fetchImpl, sleep: async () => { slept += 1; } });
  const r = await ctl.start();
  assert.equal(r.ok, true);
  assert.equal(r.test.ok, true);
  assert.equal(slept, 3);

  const never = createSpireControl({ env: baseEnv(), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'spire-n-')), run: runningContainer(), fetchImpl: async () => ({ status: 503, json: async () => ({}) }), sleep: async () => { slept += 1; } });
  const rn = await never.start();
  assert.equal(rn.ok, false);
  assert.equal(rn.started, true);
  assert.ok(slept <= 3 + 15, 'the wait is bounded');
});

test('start without docker: named docker-unavailable reason, no docker run attempted', async () => {
  const run = fakeRun(() => { throw new Error('docker: command not found'); });
  const ctl = createSpireControl({ env: baseEnv(), dataDir: os.tmpdir(), run });
  const r = await ctl.start();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'docker-unavailable');
  assert.ok(!run.calls.some((c) => c[1] === 'run'), 'no container was started');
  const rr = await ctl.restart();
  assert.equal(rr.reason, 'docker-unavailable');
});

test('start/restart refuse on the cluster target: this lab holds no cluster credentials, so it starts nothing there', async () => {
  const run = runningContainer();
  const ctl = createSpireControl({ env: baseEnv({ SPIRE_SERVER_URL: 'https://spire.example' }), dataDir: os.tmpdir(), run, fetchImpl: ready });
  for (const r of [await ctl.start(), await ctl.restart()]) {
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-local');
    assert.match(r.message, /cluster SPIRE is selected/);
  }
  assert.equal(run.calls.length, 0, 'not even docker info was run');
});

test('restart: rm then run with the same fixed argv, and the post-restart test result rides along', async () => {
  const run = runningContainer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spire-rs-'));
  const ctl = createSpireControl({ env: baseEnv(), dataDir: dir, run, fetchImpl: ready, sleep: noSleep });
  const r = await ctl.restart();
  assert.equal(r.ok, true);
  assert.equal(r.restarted, true);
  assert.equal(r.test.ok, true);
  assert.deepEqual(r.test.checks.map((c) => c.name), ['container', 'ready']);
  const docker = run.calls.filter((c) => c[0] === 'docker');
  assert.ok(docker.some((c) => c[1] === 'rm' && c[2] === '-f' && c[3] === CONTAINER_NAME));
  assert.equal(docker.filter((c) => c[1] === 'run').length, 1);
});

// A stub of a remote SPIRE: `routes` maps a URL to { status, body }.
const stubFetch = (routes, seen = []) => async (url) => {
  seen.push(url);
  const r = routes[url];
  if (!r) return { status: 404, json: async () => { throw new Error('not json'); } };
  return { status: r.status ?? 200, json: async () => r.body };
};

test('remote test: discovery, then the keys through jwks_uri (allowlisted origin), then the optional agent', async () => {
  const fetchImpl = stubFetch({
    'https://spire.example/.well-known/openid-configuration': { body: { issuer: 'https://spire.example', jwks_uri: 'https://keys.example/jwks' } },
    'https://keys.example/jwks': { body: KEYS },
    'https://agent.example': { body: {} },
  });
  const ctl = createSpireControl({ env: baseEnv({ SPIRE_SERVER_URL: 'https://spire.example', SPIRE_AGENT_URL: 'https://agent.example', SPIRE_ALLOWED_HOSTS: 'https://keys.example' }), dataDir: os.tmpdir(), fetchImpl });
  const r = await ctl.test();
  assert.equal(r.ok, true);
  assert.equal(r.tested, 'remote');
  assert.deepEqual(r.checks.map((c) => c.name), ['discovery', 'jwks', 'agent']);
  assert.match(r.checks[0].detail, /issuer https:\/\/spire\.example/);
  assert.match(r.checks[0].detail, /discovery provider's/, 'it says the discovery issuer is not necessarily the JWT iss');
  assert.match(r.checks[1].detail, /1 key \(ES256\)/);
  assert.equal(r.checks[2].ok, true);
});

test('remote test, path-prefixed base (how a shared ingress serves SPIRE): discovery under the prefix, and a jwks_uri that points at the wrong place falls back to <base>/keys with a hint', async () => {
  const seen = [];
  const fetchImpl = stubFetch({
    'https://host.example/spire/.well-known/openid-configuration': { body: { issuer: 'https://host.example', jwks_uri: 'https://host.example/keys' } }, // wrong: the prefix is missing
    'https://host.example/spire/keys': { body: KEYS },
  }, seen);
  const r = await createSpireControl({ env: baseEnv({ SPIRE_SERVER_URL: 'https://host.example/spire/' }), dataDir: os.tmpdir(), fetchImpl }).test();
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.match(r.checks[1].detail, /at https:\/\/host\.example\/spire\/keys \(default path <base>\/keys\)/);
  assert.match(r.checks[1].detail, /Discovery's jwks_uri \(https:\/\/host\.example\/keys\) is not where the keys are: use https:\/\/host\.example\/spire\/keys/);
  assert.deepEqual(seen, ['https://host.example/spire/.well-known/openid-configuration', 'https://host.example/keys', 'https://host.example/spire/keys']);
});

test('remote test: a jwks_uri outside the configured origins is never fetched; <base>/keys is tried; failures name the setting to change', async () => {
  const seen = [];
  const fetchImpl = stubFetch({ 'https://spire.example/.well-known/openid-configuration': { body: { jwks_uri: 'https://elsewhere.example/jwks' } }, 'https://elsewhere.example/jwks': { body: KEYS } }, seen);
  const r = await createSpireControl({ env: baseEnv({ SPIRE_SERVER_URL: 'https://spire.example' }), dataDir: os.tmpdir(), fetchImpl }).test();
  assert.equal(r.ok, false);
  assert.match(r.checks[1].detail, /SPIRE_ALLOWED_HOSTS/);
  assert.ok(!seen.includes('https://elsewhere.example/jwks'), 'an origin the owner did not configure is never contacted');
  assert.ok(seen.includes('https://spire.example/keys'));

  const badFetch = async () => { throw new Error('fetch failed: getaddrinfo ENOTFOUND spire.example'); };
  const r2 = await createSpireControl({ env: baseEnv({ SPIRE_SERVER_URL: 'https://spire.example' }), dataDir: os.tmpdir(), fetchImpl: badFetch }).test();
  assert.equal(r2.ok, false);
  assert.match(r2.checks[0].detail, /ENOTFOUND/);
  assert.ok(r2.checks[0].ms >= 0);
});

test('the key set is inspected: private key material is a FAIL (and never hidden behind a fallback), a missing kid, an empty set and a non-key-set are named', async () => {
  assert.equal(inspectJwks(KEYS).ok, true);
  for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k']) {
    const leaky = inspectJwks({ keys: [{ ...KEYS.keys[0], [field]: 'secret-material' }] });
    assert.equal(leaky.ok, false, field);
    assert.match(leaky.detail, new RegExp(`PRIVATE key material.*field ${field}`));
    assert.ok(!leaky.detail.includes('secret-material'), 'the value itself is never echoed');
  }
  assert.match(inspectJwks({ keys: [{ kty: 'EC' }] }).detail, /no kid/);
  assert.match(inspectJwks({ keys: [] }).detail, /empty/);
  assert.match(inspectJwks({}).detail, /not a JSON key set/);
  assert.match(inspectJwks(null).detail, /not a JSON key set/);

  // End to end: a leak at the discovery URL stops the test; the fallback path is NOT tried to paper over it.
  const seen = [];
  const fetchImpl = stubFetch({
    'https://spire.example/.well-known/openid-configuration': { body: { jwks_uri: 'https://spire.example/jwks' } },
    'https://spire.example/jwks': { body: { keys: [{ ...KEYS.keys[0], d: 'secret-material' }] } },
    'https://spire.example/keys': { body: KEYS },
  }, seen);
  const r = await createSpireControl({ env: baseEnv({ SPIRE_SERVER_URL: 'https://spire.example' }), dataDir: os.tmpdir(), fetchImpl }).test();
  assert.equal(r.ok, false);
  assert.match(r.checks[1].detail, /^PRIVATE key material/);
  assert.ok(!seen.includes('https://spire.example/keys'));
  assert.ok(!JSON.stringify(r).includes('secret-material'));
});

test('the agent probe is optional: a remote test passes without SPIRE_AGENT_URL, and fails when a configured agent is unreachable', async () => {
  const routes = { 'https://spire.example/.well-known/openid-configuration': { body: { jwks_uri: 'https://spire.example/keys' } }, 'https://spire.example/keys': { body: KEYS } };
  const without = await createSpireControl({ env: baseEnv({ SPIRE_SERVER_URL: 'https://spire.example' }), dataDir: os.tmpdir(), fetchImpl: stubFetch(routes) }).test();
  assert.equal(without.ok, true);
  assert.equal(without.checks[2].ok, false, 'the row is shown as not configured');
  assert.match(without.checks[2].detail, /optional/);

  const fetchImpl = async (url) => { if (url === 'https://agent.example') throw new Error('fetch failed: ECONNREFUSED'); return stubFetch(routes)(url); };
  const down = await createSpireControl({ env: baseEnv({ SPIRE_SERVER_URL: 'https://spire.example', SPIRE_AGENT_URL: 'https://agent.example' }), dataDir: os.tmpdir(), fetchImpl }).test();
  assert.equal(down.ok, false);
  assert.match(down.checks[2].detail, /ECONNREFUSED/);
});

test('a failed fetch names its real reason (Node hides it in the cause), without doubling it up when the message already says it', async () => {
  const withCause = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }) }); };
  const r = await createSpireControl({ env: baseEnv({ SPIRE_SERVER_URL: 'https://spire.example' }), dataDir: os.tmpdir(), fetchImpl: withCause }).test();
  assert.match(r.checks[0].detail, /^fetch failed \(ECONNREFUSED\)$/);
  const already = async () => { throw Object.assign(new TypeError('getaddrinfo ENOTFOUND spire.example'), { cause: { code: 'ENOTFOUND' } }); };
  const r2 = await createSpireControl({ env: baseEnv({ SPIRE_SERVER_URL: 'https://spire.example' }), dataDir: os.tmpdir(), fetchImpl: already }).test();
  assert.equal(r2.checks[0].detail, 'getaddrinfo ENOTFOUND spire.example');
  const local = await createSpireControl({ env: baseEnv(), dataDir: os.tmpdir(), run: runningContainer(), fetchImpl: withCause }).test();
  assert.match(local.checks[1].detail, /ECONNREFUSED/);
});

// ---- target selector: Docker demo vs the cluster SPIRE ----
const CLUSTER = { SPIRE_SERVER_URL: 'https://spire.example/spire' };
const okRemote = async (url) => {
  const u = String(url);
  if (u.endsWith('/.well-known/openid-configuration')) return { status: 200, json: async () => ({ issuer: 'https://spire.example', jwks_uri: 'https://spire.example/keys' }) };
  return { status: 200, json: async () => KEYS };
};

test('target: defaults follow the configuration (no URL = docker, a URL = cluster) and the view says why cluster is unavailable', () => {
  const none = createSpireControl({ env: baseEnv(), dataDir: os.tmpdir() }).targetView();
  assert.equal(none.target, 'docker');
  assert.equal(none.options.cluster.available, false);
  assert.match(none.options.cluster.reason, /SPIRE_SERVER_URL is not set/);
  const set = createSpireControl({ env: baseEnv(CLUSTER), dataDir: os.tmpdir() }).targetView();
  assert.equal(set.target, 'cluster');
  assert.equal(set.options.cluster.available, true);
  assert.equal(set.options.cluster.reason, null);
  assert.equal(set.serverUrl, 'https://spire.example/spire');
});

test('target: cluster cannot be selected without a valid SPIRE_SERVER_URL (409, state unchanged); a bad value is a 400', () => {
  const ctl = createSpireControl({ env: baseEnv(), dataDir: os.tmpdir() });
  assert.throws(() => ctl.setTarget('cluster'), (e) => e instanceof TargetError && e.status === 409 && e.code === 'cluster_not_configured');
  assert.equal(ctl.targetView().target, 'docker');
  const bad = createSpireControl({ env: baseEnv({ SPIRE_SERVER_URL: 'ftp://agent.example' }), dataDir: os.tmpdir() });
  assert.throws(() => bad.setTarget('cluster'), (e) => e.status === 409);
  for (const v of ['k8s', '', undefined, null, 7, {}]) assert.throws(() => ctl.setTarget(v), (e) => e.status === 400 && e.code === 'bad_target');
});

test('target: switching to docker makes test() check the local container only, and no cluster URL is fetched', async () => {
  const urls = [];
  const fetchImpl = async (u) => { urls.push(String(u)); return { status: 200, json: async () => ({}) }; };
  const ctl = createSpireControl({ env: baseEnv(CLUSTER), dataDir: os.tmpdir(), run: runningContainer(), fetchImpl });
  assert.equal(ctl.targetView().target, 'cluster');
  ctl.setTarget('docker');
  const r = await ctl.test();
  assert.equal(r.tested, 'local');
  assert.equal(r.target, 'docker');
  assert.ok(urls.length > 0 && urls.every((u) => u.startsWith('http://127.0.0.1:')), `only loopback was fetched: ${urls.join(' ')}`);
});

test('target: switching back to cluster tests the configured SPIRE and fetches nothing from loopback', async () => {
  const urls = [];
  const fetchImpl = async (u, o) => { urls.push(String(u)); return okRemote(u, o); };
  const ctl = createSpireControl({ env: baseEnv(CLUSTER), dataDir: os.tmpdir(), run: runningContainer(), fetchImpl });
  ctl.setTarget('docker');
  ctl.setTarget('cluster');
  const r = await ctl.test();
  assert.equal(r.tested, 'remote');
  assert.equal(r.target, 'cluster');
  assert.equal(r.ok, true);
  assert.ok(urls.length > 0 && urls.every((u) => u.startsWith('https://spire.example')), urls.join(' '));
});

test('target: docker selected while a cluster URL is set still starts the local container', async () => {
  const run = runningContainer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spire-tg-'));
  const ctl = createSpireControl({ env: baseEnv(CLUSTER), dataDir: dir, run, fetchImpl: ready, sleep: noSleep });
  ctl.setTarget('docker');
  const r = await ctl.start();
  assert.equal(r.reason, undefined);
  assert.equal(r.started, true);
  assert.ok(run.calls.some((c) => c[0] === 'docker' && c[1] === 'run'));
});

test('target: an invalid URL with no choice made reports a settings failure, never the local container', async () => {
  const run = runningContainer();
  const ctl = createSpireControl({ env: baseEnv({ SPIRE_SERVER_URL: 'ftp://agent.example' }), dataDir: os.tmpdir(), run, fetchImpl: ready });
  const r = await ctl.test();
  assert.equal(r.ok, false);
  assert.equal(r.tested, 'invalid');
  assert.equal(r.checks[0].name, 'settings');
  assert.equal(run.calls.length, 0);
});

test('the kubectl commands are placeholders only: no real namespace, host or secret, and nothing that deletes', () => {
  assert.ok(K8S_COMMANDS.length >= 3);
  for (const c of K8S_COMMANDS) {
    assert.match(c.command, /^kubectl /);
    assert.match(c.command, /<namespace>/);
    assert.doesNotMatch(c.command, /\bdelete\b|\bsecret|token|--force/i);
  }
});
