// Run observability (rule 27), the lab's own half. The shared collector (runObservability.js, vendored byte for byte) is never edited.
//
//   1. createRunLog keeps the decisions of each "present" run (in memory) and writes each one as ONE timestamped stdout line: the
//      workload's SPIFFE ID and the result, never a token. Each event is computed once and stamped once; the stdout line and the
//      row in the record carry that same time. The time is when the lab recorded the reply, after the whole present call finished (up to 15 s per token),
//      not when the gateway answered or wrote anything.
//   2. buildRunRecord hands the run's events to the shared collector. Mock: the rows are `simulated` (the lab's own verification
//      of each token, applied to its published JWKS). Real: the rows are `response` (the reply the gateway sent). This lab reads no
//      product log, so nothing is ever `logged`, and a layer with no event of its own is `not-logged` with the reason below.
//
// Stdout line: `<iso> spiffe-issuer-lab decision step=present actor=<spiffe id> case=<which token> status=<http status|none>
//   result=<passed|stopped|unclear|no-reply> mode=<mock|real> run=<id>`.
// The family's matchers read words such as refused, denied, rejected, forbidden, failed, invalid, expired, mismatch, token, audience,
// scope and served, so these lines use none of them (result=stopped, case from the table below). No shared matcher reads them: they
// are for a collector and a SIEM. A test runs every line through the shared classify() for every product and expects null.
import crypto from 'node:crypto';
import { createRunObservability, LAYERS } from './runObservability.js';

// A value that goes INTO a stdout line: only safe characters survive, so a SPIFFE ID or a gateway-supplied value cannot add a second
// key=value pair, a quote or a line.
export const lineValue = (v, n = 320) => String(v ?? '').replace(/[^A-Za-z0-9._:/@-]+/g, '_').slice(0, n) || '-';

const RESULT = { allowed: 'passed', refused: 'stopped', info: 'unclear' };
// Token id (as the code names it) -> the word the stdout line uses. "mismatched" and "untrusted" are words the shared matchers read.
const CASE = { valid: 'valid', mismatched: 'other-id', untrusted: 'other-key' };
const KEEP = 3; // closed runs kept per mode: the newest plus two more; an open run is never evicted
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, n);
// A long SPIFFE ID keeps its head (trust domain) and its tail (the workload name, the only part that tells two tokens apart).
const shortId = (s, n = 110) => { const t = clip(s, 1000); return t.length > n ? `${t.slice(0, 30)}...${t.slice(-(n - 33))}` : t; };

export function createRunLog({ now = Date.now, write = () => {} } = {}) {
  const runs = [];
  const iso = () => new Date(now()).toISOString();

  function begin(source) {
    const run = { id: `present-${crypto.randomBytes(6).toString('hex')}`, source, startedAt: iso(), endedAt: null, events: [] };
    runs.push(run);
    const closed = runs.filter((r) => r.source === source && r.endedAt);
    for (const r of closed.slice(0, Math.max(0, closed.length - KEEP))) runs.splice(runs.indexOf(r), 1);
    return run;
  }

  // One event: the stdout line first (always), then the run's list (only while the run is open).
  function record(run, e) {
    const at = iso();
    write(`${at} spiffe-issuer-lab decision step=present actor=${lineValue(e.sub)} case=${CASE[e.id] ?? '-'} status=${lineValue(e.status ?? 'none', 4)} result=${e.result ?? RESULT[e.outcome]} mode=${run.source} run=${run.id}`);
    if (!run.endedAt) run.events.push({ ...e, at });
  }

  function end(run) {
    if (run.endedAt) return;
    run.endedAt = iso();
    runs.splice(runs.indexOf(run), 1);
    runs.push(run); // the last closed run is the newest
  }

  // The newest CLOSED run made in this mode: a record never holds a half-open run and never one made in the other mode.
  const latest = (source) => runs.filter((r) => r.source === source && r.endedAt).at(-1) ?? null;

  return { begin, record, end, latest };
}

// ---- A reply or a verdict -> an event ----------------------------------------------------------------------------------------------
// Is a gateway reply a success? Only HTTP 200 with a usable JSON-RPC result that is not a tool error. 401 and 403 are refusals; a
// JSON-RPC `error` or `result.isError` in a 200 is a refusal; a body that was not parsed or has no result (missing or null) is not usable: `info`.
export function replyOutcome(status, body) {
  if (status === 401 || status === 403) return 'refused';
  if (status !== 200) return 'info';
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'info';
  if (body.error !== undefined && body.error !== null) return 'refused';
  if (body.result === undefined || body.result === null) return 'info';
  return body.result && body.result.isError === true ? 'refused' : 'allowed';
}

// One presented row (present.js: id, label, sub, status, words, expect, matched, source, trace) -> the decision the lab records for it.
// Mock: the lab's own verification gave 200 or 401. Real: only what the gateway answered; no answer is `no-reply` and is never a row.
// present.js takes `status` from the last POST that got any reply, so after a dropped or timed-out tools/list it is the 202 of the
// initialized notification, not an answer to the call: an unreachable or timed-out call, or a call with no response captured, is no reply.
const NO_ANSWER = new Set(['mcp_unreachable', 'mcp_timeout']);
export function eventOf(row) {
  const base = { id: row.id, label: row.label, sub: row.sub, status: row.status, expect: row.expect, matched: row.matched };
  if (row.source === 'mock') return { ...base, outcome: row.status === 200 ? 'allowed' : 'refused', words: row.words };
  if (typeof row.status !== 'number' || NO_ANSWER.has(row.error) || !row.trace?.response) return { ...base, status: null, outcome: 'info', result: 'no-reply', words: row.words };
  return { ...base, outcome: replyOutcome(row.status, row.trace?.response?.body), words: row.words };
}

// The outcome and the origin come first: a row message is cut at 300 characters, so a long SPIFFE ID or gateway text can only hide the tail.
export function describe(e, source) {
  const who = `${e.label} token for ${shortId(e.sub)}`;
  if (source === 'mock') return `Mock gateway: HTTP ${e.status} (computed by the lab, not a Privilege result). ${who}: ${clip(e.words, 240)}`;
  // A 200 whose answer holds no usable result is information; the lab's own table words ("accepted ...") would contradict that, so they are left out.
  if (e.outcome === 'info' && e.status === 200) return `Reply received from the gateway, not a log line: HTTP 200, which does not say whether it was accepted (no usable tools/list result). ${who}`;
  const why = e.outcome === 'refused' && e.status === 200 ? ' with an error in its answer' : '';
  return `Reply received from the gateway, not a log line: HTTP ${e.status}${why}. ${who}: ${clip(e.words, 240)}`;
}

// ---- The record ------------------------------------------------------------------------------------------------------------------
// The reasons are statements about this lab.
const REASONS = {
  person: 'No person signs in. The caller is a workload named by its SPIFFE ID.',
  agent: "The workload's identity is the SPIFFE ID in the sub claim of each token; the gateway rows name it. The lab mints the token itself (a test token, not an attested workload) and no product logs that.",
  authorize: 'This lab does not call PingOne Authorize, so there is no Authorize decision to show.',
  privilege: "The lab sees only the gateway's HTTP reply. Privilege policy, AI Guard and approval events are not read here.",
  resource: 'This lab calls no tool and runs no resource server: it asks the door for tools/list only.',
};
const NO_REPLY = 'No reply was received for this run: the gateway did not answer, or the call timed out.';
const someSilent = (n, total) => `${n} of ${total} tokens got no answer from the gateway (it did not answer, or the call timed out): the rows below are only the ones that did.`;
const PRODUCT = { mock: 'lab mock gateway (rehearsal)', real: 'gateway reply' };
export const NO_RUN = {
  mock: 'No Mock run yet. Press "Rehearse against the mock gateway": the record of that run appears here.',
  real: 'No Real run yet. Press "Present to the gateway": the record of that run appears here.',
};

export async function buildRunRecord({ run, clock = Date.now }) {
  const { source } = run;
  const rows = run.events.filter((e) => !e.result).map((e) => ({
    at: e.at, product: PRODUCT[source], outcome: e.outcome, message: describe(e, source),
    detail: { run: run.id, case: e.id, status: e.status, expected: e.expect, asDesigned: e.matched },
  }));
  const layers = LAYERS.map((layer) => (layer === 'gateway'
    ? { layer, products: [], [source === 'mock' ? 'simulated' : 'responses']: rows, reason: NO_REPLY }
    : { layer, products: [], reason: REASONS[layer] }));
  const record = await createRunObservability({ clock }).collectRun({ runId: run.id, startedAt: run.startedAt, endedAt: run.endedAt, layers, source });
  // A token that got no answer has no row (that would invent a reply): say so on the layer, or the rows read like a complete run.
  const silent = run.events.filter((e) => e.result === 'no-reply').length;
  if (rows.length && silent) record.reasons.gateway = someSilent(silent, run.events.length);
  return record;
}
