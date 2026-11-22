import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, startHttpServer } from '../src/app.js';
import { createRunLog, buildRunRecord, eventOf, lineValue, replyOutcome, describe as describeEvent } from '../src/runLog.js';
import { assertRunObservability, classify, layerMatchers } from '../src/runObservability.js';
import { checkPin } from '../../scripts/run-observability-checkPin.mjs';
import { baseEnv, startFakeDoor, tmpStore } from './helpers.js';

// Rule 27 for the lab: the pin, the decision lines, the record in Mock and Real, one run per record, and the honesty of every row.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SUB = 'spiffe://lab.example/ns/agents/sa/mcp-agent';
const OTHER = 'spiffe://lab.example/ns/agents/sa/other-agent';
const realEnv = (doorUrl, extra = {}) => baseEnv({ PUBLIC_URL: 'https://issuer.example', SPIFFE_GW_URL: doorUrl, SPIFFE_GW_APPS: 'door', ...extra });
const LINE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z spiffe-issuer-lab decision step=present actor=[A-Za-z0-9._:/@_-]+ case=(valid|other-id|other-key) status=(\d{3}|none) result=(passed|stopped|unclear|no-reply) mode=(mock|real) run=present-[0-9a-f]{12}$/;
const WORDS = /refused|denied|rejected|forbidden|failed|invalid|expired|mismatch|token|audience|scope|served/i;

async function start({ env = baseEnv(), store = tmpStore(), now } = {}) {
  const lines = [];
  const { server, url } = await startHttpServer({ port: 0, host: '127.0.0.1', app: createApp({ store, env, logLine: (l) => lines.push(l), ...(now ? { now } : {}) }) });
  const base = url.replace(/\/$/, '');
  const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const record = async () => (await fetch(`${base}/api/run-observability`)).json();
  return { base, store, lines, post, record, info: async () => (await fetch(`${base}/api/info`)).json(), close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

// A gateway of the test whose reply to tools/list the test chooses; initialize and the notification are always answered.
async function startGateway(reply) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
      const msg = raw ? JSON.parse(raw) : {};
      if (msg.id === undefined) { res.writeHead(202); return res.end(); }
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'g', version: '1' }, capabilities: {} } }));
      }
      const r = reply(msg, req);
      if (r.drop) return req.socket.destroy(); // the connection is reset with no reply
      res.writeHead(r.status, { 'content-type': r.type ?? 'application/json' });
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...r.body }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

const gatewayRows = (record) => record.rows.filter((r) => r.origin !== 'not-logged');

test('the vendored run-observability files match the pin, and this lab vendors the core only', () => {
  assert.deepEqual(checkPin(root), []);
  assert.ok(!fs.existsSync(path.join(root, 'server/src/runObservabilityReaders.js')), 'this lab reads no logs, so there is no readers file');
  const core = fs.readFileSync(path.join(root, 'server/src/runObservability.js'), 'utf8');
  assert.ok(!/^\s*import\s/m.test(core), 'the core has no imports');
  for (const name of fs.readdirSync(path.join(root, 'server/src')).filter((f) => f.endsWith('.js'))) {
    assert.ok(!/readersFromEnv|DockerLogReader|ElasticsearchReader|docker\.sock/.test(fs.readFileSync(path.join(root, 'server/src', name), 'utf8')), `${name} names no log reader, comments included`);
  }
});

test('compose never mounts the Docker socket and passes no run-observability settings (nothing reads them)', () => {
  for (const file of ['docker-compose.yml', '.env.example']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(!/docker\.sock/.test(text) && !/RUN_OBS_/.test(text), file);
  }
});

test('a vendored byte edited, or a file added to the vendored folders without the pin, fails the pin check', () => {
  const copy = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'spiffe-pin-'));
  try {
    for (const f of ['server/src/runObservability.js', 'web/src/run-observability/RunObservability.jsx', 'web/src/run-observability/run-observability.css', 'web/src/run-observability/run-observability.test.jsx', 'web/src/run-observability/fixtures.js', 'web/src/run-observability/run-observability.sha256']) {
      fs.mkdirSync(path.dirname(path.join(copy, f)), { recursive: true });
      fs.copyFileSync(path.join(root, f), path.join(copy, f));
    }
    assert.deepEqual(checkPin(copy), []);
    fs.appendFileSync(path.join(copy, 'web/src/run-observability/fixtures.js'), '\n// edited');
    assert.ok(checkPin(copy).length > 0, 'an edited file');
    fs.copyFileSync(path.join(root, 'web/src/run-observability/fixtures.js'), path.join(copy, 'web/src/run-observability/fixtures.js'));
    fs.writeFileSync(path.join(copy, 'server/src/runObservabilityExtra.js'), 'export {};');
    assert.ok(checkPin(copy).length > 0, 'an unpinned file');
  } finally { fs.rmSync(copy, { recursive: true, force: true }); }
});

test('Mock: a present run is a simulated record, one row per token, and each row time IS the time of its stdout line', async () => {
  const lab = await start();
  try {
    assert.deepEqual(await lab.record(), { record: null, message: 'No Mock run yet. Press "Rehearse against the mock gateway": the record of that run appears here.' });
    assert.equal((await lab.post('/api/present')).status, 200);
    const { record } = await lab.record();
    assert.deepEqual(assertRunObservability(record), []);
    assert.equal(record.source, 'mock');
    assert.equal(record.truncated, false);
    assert.equal(record.coverage.gateway, 'simulated');
    for (const layer of ['person', 'agent', 'authorize', 'privilege', 'resource']) assert.equal(record.coverage[layer], 'not-logged', layer);
    const rows = gatewayRows(record);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.origin === 'simulated' && r.layer === 'gateway' && r.product === 'lab mock gateway (rehearsal)'));
    assert.deepEqual(rows.map((r) => r.outcome), ['allowed', 'refused', 'refused']);
    assert.deepEqual(record.summary, { allowed: 1, refused: 2, blocked: 0, info: 0, unverified: 0 });
    assert.deepEqual(rows.map((r) => r.detail.status), [200, 401, 401]);
    assert.match(rows[1].message, /^Mock gateway: HTTP 401 \(computed by the lab, not a Privilege result\)\. Mismatched token for spiffe:\/\/lab\.example\/ns\/agents\/sa\/other-agent/);
    assert.match(rows[1].message, /not a Privilege result/);
    assert.deepEqual(rows.map((r) => r.at), lab.lines.map((l) => l.split(' ')[0]), 'one stamp per decision: the row time IS the stdout line time');
    assert.equal(lab.lines.length, 3);
    assert.ok(lab.lines.every((l) => LINE.test(l) && / mode=mock /.test(l)));
    assert.deepEqual(lab.lines.map((l) => /result=(\S+)/.exec(l)[1]), ['passed', 'stopped', 'stopped']);
    assert.ok(lab.lines.every((l) => l.endsWith(` run=${record.runId}`)));
    const minted = (await (await lab.post('/api/mint')).json()).tokens.map((t) => t.token);
    assert.ok(!minted.some((t) => JSON.stringify(record).includes(t) || lab.lines.join('\n').includes(t)), 'no token in the record or in a line');
    assert.ok(!/BEGIN|private/i.test(JSON.stringify(record)));
  } finally { await lab.close(); }
});

test('Real against a loopback door: 200 is allowed, the two 401s are refused, rows are response rows and never logged', async () => {
  const store = tmpStore();
  const door = await startFakeDoor({ store, issuer: 'https://issuer.example', subject: SUB });
  const lab = await start({ env: realEnv(door.url), store });
  try {
    assert.equal((await lab.info()).source, 'real');
    await lab.post('/api/present', { app: 'door' });
    const { record } = await lab.record();
    assert.deepEqual(assertRunObservability(record), []);
    assert.equal(record.source, 'real');
    assert.equal(record.coverage.gateway, 'response');
    for (const layer of ['person', 'agent', 'authorize', 'privilege', 'resource']) assert.equal(record.coverage[layer], 'not-logged', layer);
    const rows = gatewayRows(record);
    assert.deepEqual(rows.map((r) => [r.origin, r.outcome, r.product]), [['response', 'allowed', 'gateway reply'], ['response', 'refused', 'gateway reply'], ['response', 'refused', 'gateway reply']]);
    assert.match(rows[0].message, /^Reply received from the gateway, not a log line: HTTP 200\. Valid token for /);
    assert.match(rows[1].message, /workload token rejected: subject mismatch/);
    assert.ok(!record.rows.some((r) => r.origin === 'logged' || r.origin === 'simulated'));
    assert.ok(lab.lines.every((l) => LINE.test(l) && / mode=real /.test(l)));
    assert.deepEqual(lab.lines.map((l) => /status=(\S+)/.exec(l)[1]), ['200', '401', '401']);
  } finally { await lab.close(); await door.close(); }
});

test('a record belongs to the mode its run was made in: a Mock run never comes back as a Real reply, and the switch works in both directions', async () => {
  const store = tmpStore();
  const door = await startFakeDoor({ store, issuer: 'https://issuer.example', subject: SUB });
  const lab = await start({ env: realEnv(door.url), store });
  try {
    assert.equal((await lab.post('/api/mode', { source: 'mock' })).status, 200);
    await lab.post('/api/present');
    const mock = (await lab.record()).record;
    assert.equal(mock.source, 'mock');
    assert.equal((await lab.post('/api/mode', { source: 'real' })).status, 200);
    const none = await lab.record();
    assert.equal(none.record, null, 'the Mock run is not shown as a Real record');
    assert.match(none.message, /^No Real run yet/);
    await lab.post('/api/present');
    const real = (await lab.record()).record;
    assert.equal(real.source, 'real');
    assert.notEqual(real.runId, mock.runId);
    assert.ok(real.rows.filter((r) => r.origin !== 'not-logged').every((r) => r.origin === 'response'));
    await lab.post('/api/mode', { source: 'mock' });
    assert.equal((await lab.record()).record.runId, mock.runId, 'switching back shows the run made in Mock');
    const info = await lab.info();
    assert.equal(info.source, 'mock');
    assert.equal(info.realAvailable, true);
  } finally { await lab.close(); await door.close(); }
});

test('what the gateway said decides the outcome: a 200 is allowed only with a usable result; an error inside a 200 is refused; anything unparsed or unknown is information', async () => {
  let next;
  const gw = await startGateway(() => next);
  const lab = await start({ env: realEnv(gw.url) });
  const cases = [
    ['a usable result', { status: 200, body: { result: { tools: [{ name: 'whoami' }] } } }, 'allowed'],
    ['a JSON-RPC error in a 200', { status: 200, body: { error: { code: -32001, message: 'policy says no' } } }, 'refused'],
    ['a 200 with no result', { status: 200, body: {} }, 'info'],
    ['a 200 with a null result', { status: 200, body: { result: null } }, 'info'],
    ['a 200 that is not JSON', { status: 200, type: 'text/plain', body: 'maintenance' }, 'info'],
    ['a 403', { status: 403, body: 'forbidden by policy' }, 'refused'],
    ['a wrong-audience 401', { status: 401, body: { error: 'unauthorized', message: 'audience mismatch' } }, 'refused'],
    ['an expired 401', { status: 401, body: { error: 'unauthorized', message: 'token expired' } }, 'refused'],
    ['a 500', { status: 500, body: 'oops' }, 'info'],
  ];
  try {
    for (const [name, reply, want] of cases) {
      next = reply;
      await lab.post('/api/present');
      const { record } = await lab.record();
      assert.deepEqual(assertRunObservability(record), [], name);
      const rows = gatewayRows(record);
      assert.equal(rows.length, 3, name);
      assert.ok(rows.every((r) => r.outcome === want && r.origin === 'response'), `${name}: ${rows.map((r) => r.outcome)}`);
      if (want === 'info') assert.deepEqual(record.summary, { allowed: 0, refused: 0, blocked: 0, info: 3, unverified: 0 }, `${name}: information is never counted as passed`);
      assert.match(lab.lines.at(-1), want === 'allowed' ? /result=passed/ : want === 'refused' ? /result=stopped/ : /result=unclear/, name);
    }
  } finally { await lab.close(); await gw.close(); }
});

test('a gateway that cannot be reached: the layer is not-logged with the reason, no row is invented, and the lines say no-reply', async () => {
  const lab = await start({ env: realEnv('http://127.0.0.1:1') });
  try {
    assert.equal((await lab.post('/api/present')).status, 502);
    const { record } = await lab.record();
    assert.deepEqual(assertRunObservability(record), []);
    assert.equal(record.coverage.gateway, 'not-logged');
    assert.match(record.reasons.gateway, /No reply was received/);
    assert.equal(gatewayRows(record).length, 0);
    assert.equal(lab.lines.length, 3);
    assert.ok(lab.lines.every((l) => LINE.test(l) && / status=none result=no-reply mode=real /.test(l)));
  } finally { await lab.close(); }
});

test('a call dropped after the handshake: the 202 of the notification is not a reply, so there is no row, no 202 anywhere, and the lines say no-reply with status none', async () => {
  const gw = await startGateway(() => ({ drop: true }));
  const lab = await start({ env: realEnv(gw.url) });
  try {
    const r = await lab.post('/api/present');
    assert.equal(r.status, 502, 'the lab\'s own unreachable path fires');
    assert.equal((await r.json()).error, 'gateway_unreachable');
    const { record } = await lab.record();
    assert.deepEqual(assertRunObservability(record), []);
    assert.equal(record.coverage.gateway, 'not-logged');
    assert.match(record.reasons.gateway, /No reply was received/);
    assert.equal(gatewayRows(record).length, 0);
    assert.ok(!/HTTP 202|"status":202/.test(JSON.stringify(record)) && !lab.lines.some((l) => /status=202/.test(l)), 'no 202 anywhere');
    assert.ok(lab.lines.length === 3 && lab.lines.every((l) => LINE.test(l) && / status=none result=no-reply mode=real /.test(l)));
  } finally { await lab.close(); await gw.close(); }
});

test('one token with no answer: its row is not invented, and the layer says that the rows are only the ones that did answer', async () => {
  let calls = 0;
  const gw = await startGateway(() => (++calls === 2 ? { drop: true } : { status: 200, body: { result: { tools: [{ name: 'whoami' }] } } }));
  const lab = await start({ env: realEnv(gw.url) });
  try {
    assert.equal((await lab.post('/api/present')).status, 200);
    const { record } = await lab.record();
    assert.deepEqual(assertRunObservability(record), []);
    assert.equal(record.coverage.gateway, 'response');
    assert.equal(gatewayRows(record).length, 2);
    assert.deepEqual(record.summary, { allowed: 2, refused: 0, blocked: 0, info: 0, unverified: 0 });
    assert.equal(record.reasons.gateway, '1 of 3 tokens got no answer from the gateway (it did not answer, or the call timed out): the rows below are only the ones that did.');
    assert.deepEqual(lab.lines.map((l) => /status=(\S+) result=(\S+)/.exec(l).slice(1).join(' ')), ['200 passed', 'none no-reply', '200 passed']);
    assert.deepEqual(gatewayRows(record).map((r) => r.detail.case), ['valid', 'untrusted']);
  } finally { await lab.close(); await gw.close(); }
});

test('a refused switch to Real (not configured) begins no run: it logs nothing and leaves the record alone', async () => {
  const lab = await start({ env: baseEnv() });
  try {
    await lab.post('/api/present');
    const run = (await lab.record()).record.runId;
    const before = lab.lines.length;
    assert.equal((await lab.post('/api/mode', { source: 'real' })).status, 409);
    assert.equal(lab.lines.length, before);
    assert.equal((await lab.record()).record.runId, run);
  } finally { await lab.close(); }
});

test('hostile gateway words cannot add a key=value pair, a quote or a second line to a decision line, and no credential reaches the record', async () => {
  const jwt = `eyJhbGciOiJSUzI1NiJ9.${'a'.repeat(40)}.${'b'.repeat(40)}`;
  const gw = await startGateway(() => ({ status: 401, body: { error: 'x', message: `no\n2026-11-22T00:00:00.000Z spiffe-issuer-lab decision step=present actor=x result=passed Bearer ${jwt} password=hunter2xyz ${'z'.repeat(5000)}` } }));
  const lab = await start({ env: realEnv(gw.url) });
  try {
    await lab.post('/api/present');
    assert.equal(lab.lines.length, 3, 'one line per decision');
    for (const l of lab.lines) { assert.match(l, LINE); assert.ok(l.length < 400); assert.ok(!/hunter2xyz|eyJ/.test(l)); }
    const { record } = await lab.record();
    assert.deepEqual(assertRunObservability(record), []);
    assert.ok(!/hunter2xyz|eyJhbGci/.test(JSON.stringify(record)), 'masked before it leaves the server');
    assert.equal(record.rows.filter((r) => r.origin === 'response').length, 3);
  } finally { await lab.close(); await gw.close(); }
  assert.equal(lineValue('a b=c\n"d"'), 'a_b_c_d_');
  assert.equal(lineValue(''), '-');
});

test('every kind of decision line is in the lab vocabulary and no shared matcher reads one for any product, even with words in the configured SPIFFE names', async () => {
  const store = tmpStore();
  const door = await startFakeDoor({ store, issuer: 'https://issuer.example', subject: 'spiffe://lab.example/ns/agents/sa/mcp-agent' });
  const real = await start({ env: realEnv(door.url), store });
  const odd = await start({ env: baseEnv({ SPIFFE_AGENT: 'refused-token', SPIFFE_OTHER_AGENT: 'denied-audience', SPIFFE_NAMESPACE: 'expired' }) });
  try {
    await real.post('/api/present');
    await odd.post('/api/present');
    const lines = [...real.lines, ...odd.lines];
    assert.equal(lines.length, 6);
    const products = [...new Set(layerMatchers.map((m) => m.product))];
    assert.ok(products.length >= 5);
    for (const line of lines) {
      assert.match(line, LINE);
      assert.ok(!WORDS.test(line.replace(/ actor=\S+/, '')), `the lab's own words avoid the matchers' vocabulary: ${line}`);
      for (const product of products) {
        assert.equal(classify({ product, message: line, at: Date.parse(line.split(' ')[0]), atExact: line.split(' ')[0] }, []), null, `${product}: ${line}`);
        assert.equal(classify({ product, message: `[${line.split(' ')[0]}] INFO: ${line.split(' ').slice(1).join(' ')}`, at: 0, atExact: '' }, []), null, `${product} behind a header`);
      }
    }
    assert.ok(odd.lines.every((l) => /actor=spiffe:\/\/lab\.example\/ns\/expired\/sa\/(refused-token|denied-audience) /.test(l)));
  } finally { await real.close(); await odd.close(); await door.close(); }
});

test('one run per record: two overlapping runs never share events', async () => {
  const lab = await start();
  try {
    const [a, b] = await Promise.all([lab.post('/api/present'), lab.post('/api/present')]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const { record } = await lab.record();
    const rows = gatewayRows(record);
    assert.equal(rows.length, 3, 'exactly one run: 3 decisions, not 6');
    assert.equal(new Set(rows.map((r) => r.detail.run)).size, 1);
    assert.equal(new Set(lab.lines.map((l) => / run=(\S+)$/.exec(l)[1])).size, 2);
  } finally { await lab.close(); }
});

test('events after a run is closed do not join it, the list is bounded per mode, and an open run is never evicted', () => {
  const written = [];
  const log = createRunLog({ now: () => Date.UTC(2026, 10, 22, 10, 0, 0), write: (l) => written.push(l) });
  const ev = { id: 'valid', label: 'Valid', sub: SUB, status: 200, outcome: 'allowed' };
  const run = log.begin('mock');
  log.record(run, ev);
  log.end(run);
  log.record(run, ev);
  assert.equal(run.events.length, 1);
  assert.equal(written.length, 2, 'the late decision is still logged to stdout');
  const open = log.begin('real');
  const closed = [];
  for (let i = 0; i < 20; i += 1) { const r = log.begin('mock'); log.end(r); closed.push(r.id); }
  log.record(open, ev);
  assert.equal(log.latest('real'), null, 'an open run is not a record yet');
  log.end(open);
  assert.equal(log.latest('real').id, open.id, 'the open run survived 20 newer runs of the other mode');
  assert.equal(log.latest('mock').id, closed.at(-1));
  log.begin('mock');
  assert.equal(log.latest('mock').id, closed.at(-1), 'a run that is still open never replaces the newest closed one');
});

test('replyOutcome and eventOf never turn information into a pass', () => {
  assert.equal(replyOutcome(200, { result: {} }), 'allowed');
  assert.equal(replyOutcome(200, { result: { isError: true } }), 'refused');
  assert.equal(replyOutcome(200, { error: { code: 1 } }), 'refused');
  assert.equal(replyOutcome(200, {}), 'info');
  assert.equal(replyOutcome(200, { result: null }), 'info');
  assert.equal(replyOutcome(200, 'text'), 'info');
  assert.equal(replyOutcome(200, [1]), 'info');
  assert.equal(replyOutcome(200, null), 'info');
  assert.equal(replyOutcome(401, null), 'refused');
  assert.equal(replyOutcome(403, 'x'), 'refused');
  assert.equal(replyOutcome(302, {}), 'info');
  assert.equal(replyOutcome(500, { result: {} }), 'info');
  const base = { id: 'valid', label: 'Valid', sub: SUB, expect: 200, matched: true, words: 'w' };
  assert.equal(eventOf({ ...base, source: 'real', status: 200, trace: { response: { body: { result: {} } } } }).outcome, 'allowed');
  assert.equal(eventOf({ ...base, source: 'real', status: 200, trace: { response: { body: 'x' } } }).outcome, 'info');
  assert.equal(eventOf({ ...base, source: 'real', status: 200, trace: { response: { body: { result: null } } } }).outcome, 'info');
  // no response captured for the call (the status is then another exchange's, such as the 202 of the notification): no reply, status none
  for (const row of [{ status: 202, error: 'mcp_unreachable', trace: { response: null } }, { status: 202, error: 'mcp_timeout', trace: { response: { status: 202 } } }, { status: 202, trace: { response: null } }, { status: 200, trace: null }]) {
    const e = eventOf({ ...base, source: 'real', ...row });
    assert.deepEqual([e.result, e.status, e.outcome], ['no-reply', null, 'info'], JSON.stringify(row));
  }
  assert.equal(eventOf({ ...base, source: 'real', status: null }).result, 'no-reply');
  assert.equal(eventOf({ ...base, source: 'mock', status: 401 }).outcome, 'refused');
  assert.equal(eventOf({ ...base, source: 'mock', status: 200 }).outcome, 'allowed');
});

test('describe() follows its event: a refusal is never worded as a pass, an unreadable 200 says so, and the Mock words say they are not a Privilege result', () => {
  const e = { label: 'Untrusted', sub: OTHER, status: 401, words: 'no', outcome: 'refused' };
  assert.match(describeEvent(e, 'real'), /^Reply received from the gateway, not a log line: HTTP 401\. Untrusted token for spiffe:\/\/lab\.example\/ns\/agents\/sa\/other-agent: no$/);
  assert.match(describeEvent({ ...e, status: 200 }, 'real'), /HTTP 200 with an error in its answer\./);
  const unread = describeEvent({ ...e, status: 200, outcome: 'info', words: 'accepted: tools/list returned 0 tools' }, 'real');
  assert.match(unread, /HTTP 200, which does not say whether it was accepted/);
  assert.ok(!/accepted: tools/.test(unread), 'the lab\'s own "accepted" words are not repeated beside an information row');
  assert.match(describeEvent({ ...e, status: 500, outcome: 'info' }, 'real'), /HTTP 500\. Untrusted token for /);
  assert.match(describeEvent(e, 'mock'), /not a Privilege result/);
  const tail = 'sa/the-workload-name-that-tells-two-tokens-apart';
  const long = describeEvent({ ...e, sub: `spiffe://${'a'.repeat(300)}/${tail}`, words: 'w'.repeat(500) }, 'real');
  assert.ok(long.includes(`...${'a'.repeat(5)}`) && long.includes(`/${tail}:`), 'a long ID keeps its head and its tail');
  assert.ok(long.startsWith('Reply received from the gateway, not a log line: HTTP 401. '), 'the outcome and origin come first, so a cut can only hide the tail');
});

test('a record that cannot be built is a JSON error with the right status, logged to stderr by code and message only', async () => {
  const lab = await start({ now: () => 1000 }); // 1970: outside the window the collector accepts
  const seen = [];
  const original = console.error;
  console.error = (...a) => seen.push(a.join(' '));
  try {
    await lab.post('/api/present');
    const r = await fetch(`${lab.base}/api/run-observability`);
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.error, 'bad_window');
    assert.match(body.message, /between the years 2000 and 2100/);
    assert.ok(seen.some((l) => /run-observability: bad_window/.test(l)));
  } finally { console.error = original; await lab.close(); }
});

test('the record route is GET only, and the rule-19 info and toggle are untouched by a run and a read', async () => {
  const store = tmpStore();
  const door = await startFakeDoor({ store, issuer: 'https://issuer.example', subject: SUB });
  const lab = await start({ env: realEnv(door.url), store });
  try {
    assert.equal((await lab.post('/api/run-observability')).status, 404);
    const before = await lab.info();
    await lab.post('/api/present');
    await lab.record();
    assert.deepEqual(await lab.info(), before);
    assert.equal((await lab.post('/api/mode', { source: 'mock' })).status, 200);
    assert.equal((await lab.post('/api/mode', { source: 'real' })).status, 200);
    assert.equal((await lab.post('/api/mode', { source: 'real', extra: 1 })).status, 400);
  } finally { await lab.close(); await door.close(); }
});

test('declared and undeclared ids: an undeclared 32-hex id is shown as <id>, a long record is not marked cut, and a Mock record holds no logged row', async () => {
  const hex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const run = { id: 'present-0123456789ab', source: 'mock', startedAt: '2026-11-22T10:00:00.000Z', endedAt: '2026-11-22T10:00:05.000Z', events: [
    { id: 'valid', label: 'Valid', sub: `spiffe://lab.example/ns/${hex}/sa/x`, status: 401, outcome: 'refused', words: 'no', expect: 200, matched: false, at: '2026-11-22T10:00:01.000Z' },
  ] };
  const record = await buildRunRecord({ run });
  assert.deepEqual(assertRunObservability(record), []);
  assert.equal(record.truncated, false);
  const row = record.rows.find((r) => r.origin === 'simulated');
  assert.ok(row.message.includes('<id>') && !row.message.includes(hex));
  assert.ok(!record.rows.some((r) => r.origin === 'logged'));
  await assert.rejects(() => buildRunRecord({ run: { ...run, source: 'bogus' } }), /source must be mock or real/);
});
