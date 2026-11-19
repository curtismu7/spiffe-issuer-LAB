import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSpireControl, dockerRunArgs, parseSpireSettings, serverConfText,
  COMMAND_SHOWN, CONTAINER_NAME, SPIRE_IMAGE, LOCAL_PORT,
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

test('settings: unset URLs mean local, set URLs must be clean origins, the allowlist is parsed', () => {
  const local = parseSpireSettings(baseEnv());
  assert.equal(local.mode, 'local');
  assert.equal(local.serverUrl, null);
  assert.deepEqual(local.problems, []);

  const remote = parseSpireSettings(baseEnv({ SPIRE_SERVER_URL: 'https://spire.example', SPIRE_AGENT_URL: 'https://agent.example', SPIRE_ALLOWED_HOSTS: 'https://keys.example, https://more.example' }));
  assert.equal(remote.mode, 'remote');
  assert.equal(remote.serverUrl, 'https://spire.example');
  assert.deepEqual(remote.allowedOrigins, ['https://keys.example', 'https://more.example']);

  const bad = parseSpireSettings(baseEnv({ SPIRE_SERVER_URL: 'http://spire.example', SPIRE_ALLOWED_HOSTS: 'nonsense' }));
  assert.equal(bad.problems.length, 2, bad.problems.join('; '));
});

test('command construction: a fixed argv, the exact container name and image, loopback-only publish, no shell string', () => {
  const run = runningContainer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spire-cfg-'));
  const ctl = createSpireControl({ env: baseEnv(), dataDir: dir, run });
  return ctl.start().then(() => {
    const docker = run.calls.filter((c) => c[0] === 'docker');
    const runCmd = docker.find((c) => c[1] === 'run');
    assert.ok(runCmd, 'a docker run was issued');
    assert.deepEqual(runCmd.slice(3, 5), ['--name', CONTAINER_NAME]);
    assert.ok(runCmd.includes(SPIRE_IMAGE));
    assert.ok(runCmd.includes(`127.0.0.1:${LOCAL_PORT}:8080`), 'the port is published on loopback only');
    assert.ok(runCmd.some((a) => String(a).includes('0.0.0.0') === false || a.startsWith('-p')), 'no wildcard bind');
    assert.equal(dockerRunArgs({ confDir: '/data/spire' }).indexOf('-p'), 6);
    const mount = runCmd.find((a) => a.startsWith('-v') === false && a.includes('/opt/spire/conf/server'));
    assert.ok(mount && mount.startsWith(path.join(dir, 'spire') + ':'), 'the conf dir is mounted from the data dir');
    assert.match(fs.readFileSync(path.join(dir, 'spire', 'server.conf'), 'utf8'), /trust_domain = "demo.spiffe"/);
    assert.match(fs.readFileSync(path.join(dir, 'spire', 'server.conf'), 'utf8'), /NodeAttestor "join_token"/);
    // The education string shows the same command with a placeholder path, never the host path.
    assert.equal(COMMAND_SHOWN, `docker run -d --name ${CONTAINER_NAME} -p 127.0.0.1:${LOCAL_PORT}:8080 -v <data>/spire:/opt/spire/conf/server:ro ${SPIRE_IMAGE} -config /opt/spire/conf/server/server.conf`);
  });
});

test('local test result: structured shape, container and api-port checks, pass and fail', async () => {
  const up = createSpireControl({ env: baseEnv(), dataDir: os.tmpdir(), run: runningContainer(), probe: async () => true, now: () => new Date(0) });
  const upResult = await up.test();
  assert.equal(upResult.ok, true);
  assert.equal(upResult.tested, 'local');
  assert.equal(upResult.testedAt, new Date(0).toISOString());
  assert.deepEqual(upResult.checks.map((c) => c.name), ['container', 'api-port']);
  for (const c of upResult.checks) { assert.equal(c.ok, true, c.name); assert.equal(typeof c.ms, 'number'); assert.equal(typeof c.detail, 'string'); }

  const down = createSpireControl({ env: baseEnv(), dataDir: os.tmpdir(), run: stoppedContainer(), probe: async () => false });
  const downResult = await down.test();
  assert.equal(downResult.ok, false);
  assert.ok(downResult.checks.every((c) => c.ok === false));
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

test('restart: stop/rm then run with the same fixed argv, and the post-restart test result rides along', async () => {
  const run = runningContainer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spire-rs-'));
  const ctl = createSpireControl({ env: baseEnv(), dataDir: dir, run, probe: async () => true });
  const r = await ctl.restart();
  assert.equal(r.ok, true);
  assert.equal(r.restarted, true);
  assert.equal(r.test.ok, true);
  assert.deepEqual(r.test.checks.map((c) => c.name), ['container', 'api-port']);
  const docker = run.calls.filter((c) => c[0] === 'docker');
  assert.ok(docker.some((c) => c[1] === 'rm' && c[2] === '-f' && c[3] === CONTAINER_NAME));
  assert.ok(docker.some((c) => c[1] === 'run'));
  assert.equal(docker.filter((c) => c[1] === 'run').length, 1);
});

test('remote test: fetches discovery then jwks_uri through a stub fetch, allowlist respected', async () => {
  const jwks = { keys: [{ kty: 'RSA', kid: 'k1' }] };
  const fetchImpl = async (url) => {
    if (url === 'https://spire.example/.well-known/openid-configuration') return { status: 200, json: async () => ({ issuer: 'https://spire.example', jwks_uri: 'https://keys.example/jwks' }) };
    if (url === 'https://keys.example/jwks') return { status: 200, json: async () => jwks };
    if (url === 'https://agent.example') return { status: 200, json: async () => ({ ok: true }) };
    throw new Error(`unexpected fetch ${url}`);
  };
  const ctl = createSpireControl({ env: baseEnv({ SPIRE_SERVER_URL: 'https://spire.example', SPIRE_AGENT_URL: 'https://agent.example', SPIRE_ALLOWED_HOSTS: 'https://keys.example' }), dataDir: os.tmpdir(), fetchImpl });
  const r = await ctl.test();
  assert.equal(r.ok, true);
  assert.equal(r.tested, 'remote');
  assert.deepEqual(r.checks.map((c) => c.name), ['discovery', 'jwks', 'agent']);
  assert.match(r.checks[1].detail, /1 key/);
  assert.equal(r.checks[2].ok, true, 'the agent check passed');
});

test('remote test: a jwks_uri outside the configured origins is refused, and failures are named', async () => {
  const fetchImpl = async () => ({ status: 200, json: async () => ({ jwks_uri: 'https://elsewhere.example/jwks' }) });
  const ctl = createSpireControl({ env: baseEnv({ SPIRE_SERVER_URL: 'https://spire.example' }), dataDir: os.tmpdir(), fetchImpl });
  const r = await ctl.test();
  assert.equal(r.ok, false);
  assert.match(r.checks[1].detail, /SPIRE_ALLOWED_HOSTS/);

  const badFetch = async () => { throw new Error('fetch failed: getaddrinfo ENOTFOUND spire.example'); };
  const ctl2 = createSpireControl({ env: baseEnv({ SPIRE_SERVER_URL: 'https://spire.example' }), dataDir: os.tmpdir(), fetchImpl: badFetch });
  const r2 = await ctl2.test();
  assert.equal(r2.ok, false);
  assert.match(r2.checks[0].detail, /ENOTFOUND/);
  assert.ok(r2.checks[0].ms >= 0);
});

test('the generated server.conf is minimal and carries the demo trust domain', () => {
  const conf = serverConfText();
  assert.match(conf, /trust_domain = "demo.spiffe"/);
  assert.match(conf, /bind_address = "127.0.0.1"/);
  assert.match(conf, /join_token/);
  assert.match(conf, /KeyManager "disk"/);
});
