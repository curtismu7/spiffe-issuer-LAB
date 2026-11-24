// Story wiring: the lab's own glue between the shared Story engine (web/src/story/, vendored) and this page. It turns the script (storyScript.js) into
// engine steps and gives the engine a `host` that reads and drives the page. It never edits the page's own markup; it clicks the page's own Present
// button with a script-made event (isTrusted is false, so Play for me is not mistaken for the viewer's own input).
//
// The page (App.jsx) announces runs with spiffe:run-start and spiffe:run-end ({ ok }): ok is false only when the request itself failed. A present
// that the gateway refused (a 401 row, or a 502 when the gateway is unreachable) completes normally — the rows show it — so it is a run that ended ok.

import { STEPS } from './storyScript.js';

const text = (el) => (el && el.textContent ? el.textContent.trim() : '');
const clean = (w) => String(w || '').replace(/\s*(REAL|MOCK)\s*$/, '').trim();

/** The gateway's words, first clause only, as take.py's short() reads them (the rest is headers and metadata). */
export function shortWords(w) {
  return clean(w).split(' | ')[0].trim();
}

/** How many tools the valid row says came back, as take.py reads it: the number in "returned N tool...". */
export function toolCount(w) {
  const m = /\breturned (\d+) tool/.exec(String(w || ''));
  return m ? m[1] : '';
}

export function createHost({ win = window, doc = document, mode = () => 'mock', settleMs = 500 } = {}) {
  const runs = { starts: 0, ends: 0, lastOk: true };
  const waiters = new Set();
  const timers = new Set();
  const watchers = new Set();  // onRun subscribers: told when a run starts or ends, so the bar can say whose turn it is
  const onStart = () => { runs.starts += 1; watchers.forEach((f) => f()); };
  const onEnd = (e) => {
    runs.ends += 1; runs.lastOk = e.detail ? e.detail.ok !== false : true;
    for (const w of [...waiters]) w(runs.lastOk);
    watchers.forEach((f) => f());
  };
  win.addEventListener('spiffe:run-start', onStart);
  win.addEventListener('spiffe:run-end', onEnd);

  const q = (sel) => doc.querySelector(sel);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (el) => { if (!el || el.disabled) throw new Error('the button is not available'); el.click(); };
  const rowOf = (id) => doc.querySelector(`[data-testid=row-${id}]`);
  const wordsOf = (id) => text(doc.querySelector(`[data-testid=words-${id}]`));
  const statusOf = (id) => text(doc.querySelector(`[data-testid=status-${id}]`));

  return {
    mode,
    query: q,
    mark: () => ({ starts: runs.starts, ends: runs.ends }),
    runStarted: (m) => runs.starts > m.starts,
    runInFlight: () => runs.starts > runs.ends,
    onRun: (cb) => { watchers.add(cb); return () => watchers.delete(cb); },
    waitForRun(m, timeoutMs) {
      return new Promise((resolve) => {
        const finish = (r) => { clearTimeout(t); timers.delete(t); waiters.delete(check); resolve(r); };
        const done = (ok, reason) => finish(ok ? { ok: true } : { ok: false, reason: reason || 'The run failed. Press Next to carry on, or Exit.' });
        const check = (ok, reason) => { if (reason || runs.ends > m.ends) done(ok, reason); };
        const t = setTimeout(() => finish({ ok: false, reason: 'The run did not finish in time. Press Next to carry on, or Exit.' }), timeoutMs);
        timers.add(t);
        if (runs.ends > m.ends) { done(runs.lastOk); return; }
        waiters.add(check);
      });
    },
    prefill(step) { if (step.prompt && step.prompt.text) { /* this lab prompts by pressing a button, not filling a box */ } },
    send(step) { if (step.prompt && step.prompt.press) click(q(step.prompt.press)); },
    assetUrl: () => null,   // no screenshot ships; a slide is text-only
    dispose() { win.removeEventListener('spiffe:run-start', onStart); win.removeEventListener('spiffe:run-end', onEnd); timers.forEach(clearTimeout); timers.clear(); waiters.clear(); watchers.clear(); },
    _sleep: sleep, _settleMs: settleMs,
    _rowOf: rowOf, _wordsOf: wordsOf, _statusOf: statusOf,
  };
}

// ---- finding what a bubble points at
const payloadBox = (doc, id) => doc.querySelector(`[data-testid=json-${id}-box]`);

function targetFor(doc, host, t) {
  if (!t) return null;
  if (typeof t === 'string') return t;
  if (t.row) {
    // A results row, only when the page says what the bubble claims (the video's own checks: take.py refuses to claim success unless the rows do).
    return () => {
      const row = host._rowOf(t.row);
      if (!row) return null;
      if (t.check === 'accepted' && !/^(accepted|2\d\d)/i.test(shortWords(host._wordsOf(t.row)))) return null;
      return row;
    };
  }
  if (t.validExchange) {
    // The trace exchange of the Valid token: the first details.gw-ex whose summary names it (take.py's own rule).
    return () => {
      const first = [...doc.querySelectorAll('details.gw-ex')].find((d) => /valid token/i.test(text(d.querySelector(':scope > summary'))));
      if (!first) return null;
      first.open = true;
      return first.querySelector('.gw-io') || first;
    };
  }
  if (t.runRecord) {
    // The run record panel, only when it has a record. The target is its summary line (a narrow element the bubble can sit beside):
    // the whole card is nearly the page's width, so a bubble pointed at the card would always cover it.
    return () => {
      const p = doc.querySelector('[data-testid=run-record]');
      if (!p || p.querySelector('[data-testid=ro-empty]') || p.querySelector('[data-testid=run-record-none]')) return null;
      return p.querySelector('[data-testid=ro-summary]') || p;
    };
  }
  if (t.selector) {
    return () => { const e = doc.querySelector(t.selector); return e ? e : null; };
  }
  return null;
}

// ---- the live fact lines a bubble shows (what the video's take read from the page), and the {live} values the wording fills
function liveFor(doc, host, step) {
  const ttl = () => { const note = doc.querySelector('[data-testid=tokens] .card__note'); const m = /valid for (\d+) seconds/.exec(text(note)); return m ? m[1] : ''; };
  const status = () => text(doc.querySelector('[data-testid=status-valid]'));
  const tools = () => toolCount(host._wordsOf('valid'));
  const words = () => { const m = shortWords(host._wordsOf('mismatched')); const u = shortWords(host._wordsOf('untrusted')); return m && u ? `Mismatched: "${m}". Untrusted: "${u}"` : ''; };
  switch (step.lines) {
    case 'ttl': return { ttl };
    case 'validRow': return { status, tools };
    case 'refusals': return { words };
    default: return undefined;
  }
}

function linesFor(doc, host, step) {
  const ttl = () => { const note = doc.querySelector('[data-testid=tokens] .card__note'); const m = /valid for (\d+) seconds/.exec(text(note)); return m ? [`${m[1]} seconds`] : []; };
  switch (step.lines) {
    case 'ttl': return ttl;
    case 'validRow': return () => { const w = shortWords(host._wordsOf('valid')); const tools = toolCount(host._wordsOf('valid')); const s = host._statusOf('valid'); return [s ? `HTTP ${s}` : '', tools ? `${tools} tools came back` : w].filter(Boolean); };
    case 'refusals': return () => { const m = shortWords(host._wordsOf('mismatched')); const u = shortWords(host._wordsOf('untrusted')); return [m && u ? `Mismatched: "${m}". Untrusted: "${u}".` : ''].filter(Boolean); };
    default: return undefined;
  }
}

// Steps left out of the walk-through: none.
export const NOT_YET = [];

/** The script as engine steps. */
export function buildSteps({ host, doc = document, win = window, script = STEPS, notYet = NOT_YET } = {}) {
  return script.filter((s) => !notYet.includes(s.key)).map((s) => {
    const step = { key: s.key, type: s.type, trigger: s.trigger, modes: s.modes, sampleKey: s.sampleKey, prefer: s.prefer, place: s.place, fixedSecs: s.fixedSecs, frameTimeoutMs: s.frameTimeoutMs };
    if (s.prompt) step.prompt = s.prompt;
    if (s.type === 'bubble') {
      step.target = targetFor(doc, host, s.target);
      const live = liveFor(doc, host, s);
      if (live) step.live = () => Object.fromEntries(Object.entries(live).map(([k, f]) => [k, f()]));
      const lines = linesFor(doc, host, s);
      if (lines) step.lines = lines;
    }
    if (s.key === 'closing') {
      // The simulated run never claims a live one: its closing lead and first bullet come from the Mock wording.
      step.transform = (slide, mode) => (mode === 'mock'
        ? { ...slide, lead: 'This sample ran the lab in Mock mode: one right token accepted, two wrong ones refused, by a stand-in.', colA: { ...slide.colA, lines: ['Presented each to the mock stand-in, not a gateway', ...slide.colA.lines.slice(1)] } }
        : slide);
    }
    return step;
  });
}
