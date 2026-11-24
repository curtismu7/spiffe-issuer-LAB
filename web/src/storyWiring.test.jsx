// The lab's Story glue: the host (run events, the Present press), the script turned into engine steps, and the live fact lines.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { createHost, buildSteps, shortWords, toolCount, NOT_YET } from "./storyWiring.js";
import { STEPS, STORY_ONLY } from "./storyScript.js";
import { parseCaptions } from "../../server/src/story/captions.js";

// vitest runs from web/ (npm test -w web) or the repo root; the wording file is the lab's own video/captions.md
const captionsFile = ["../video/captions.md", "video/captions.md"].find((f) => existsSync(f));
const captions = parseCaptions(readFileSync(captionsFile, "utf8"));
const fire = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));

beforeEach(() => { document.body.innerHTML = ""; });
afterEach(() => { vi.useRealTimers(); });

describe("shortWords and toolCount (the video's own reading of a row)", () => {
  test("cuts a row's words to its first clause and drops the MOCK/REAL chip word", () => {
    expect(shortWords("accepted: it checks out | X-Foo: bar")).toBe("accepted: it checks out");
    expect(shortWords("Bearer token required MOCK")).toBe("Bearer token required");
    expect(shortWords("workload token rejected: audience mismatch REAL")).toBe("workload token rejected: audience mismatch");
    expect(shortWords("")).toBe("");
  });
  test("toolCount reads the video's own phrase", () => {
    expect(toolCount("accepted: returned 7 tool(s)")).toBe("7");
    expect(toolCount("accepted")).toBe("");
  });
});

describe("host: runs", () => {
  test("waitForRun resolves when a run ends after the mark; a run that ended before the mark does not count", async () => {
    const host = createHost({});
    fire("spiffe:run-start"); fire("spiffe:run-end", { ok: true });
    const m = host.mark();
    const p = host.waitForRun(m, 5000);
    fire("spiffe:run-start"); expect(host.runStarted(m)).toBe(true);
    fire("spiffe:run-end", { ok: true });
    await expect(p).resolves.toEqual({ ok: true });
    host.dispose();
  });

  test("a run that finished between the mark and the wait resolves at once; a failed request is not ok; a run that never ends times out", async () => {
    const host = createHost({});
    const m = host.mark(); fire("spiffe:run-end", { ok: false });
    await expect(host.waitForRun(m, 5000)).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/failed/) });
    vi.useFakeTimers();
    const p = host.waitForRun(host.mark(), 1000); vi.advanceTimersByTime(1001);
    await expect(p).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/did not finish in time/) });
    host.dispose();
  });

  test("dispose clears the wait timers (a torn-down Story leaves nothing running)", () => {
    vi.useFakeTimers(); const host = createHost({}); host.waitForRun(host.mark(), 180000);
    expect(vi.getTimerCount()).toBe(1); host.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  test("the host says when a run is in flight and tells subscribers as runs start and end", () => {
    const host = createHost({}); const seen = vi.fn(); const off = host.onRun(seen);
    expect(host.runInFlight()).toBe(false);
    fire("spiffe:run-start"); expect(host.runInFlight()).toBe(true);
    fire("spiffe:run-end", { ok: true }); expect(host.runInFlight()).toBe(false);
    expect(seen).toHaveBeenCalledTimes(2); off(); fire("spiffe:run-start"); expect(seen).toHaveBeenCalledTimes(2);
    host.dispose();
  });

  test("after dispose the host no longer counts runs", () => {
    const host = createHost({}); host.dispose();
    const m = host.mark(); fire("spiffe:run-start"); expect(host.runStarted(m)).toBe(false);
  });
});

describe("host: the page", () => {
  test("send presses the page's own Present button with a script-made event", () => {
    document.body.innerHTML = '<button data-testid="present">Present</button>';
    const host = createHost({});
    const onClick = vi.fn((e) => { expect(e.isTrusted).toBe(false); });
    document.querySelector("[data-testid=present]").addEventListener("click", onClick);
    host.send({ prompt: { press: "[data-testid=present]" } });
    expect(onClick).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  test("send throws when the button is busy or missing (Play stops with a message)", () => {
    document.body.innerHTML = '<button data-testid="present" disabled>Presenting…</button>';
    const host = createHost({});
    expect(() => host.send({ prompt: { press: "[data-testid=present]" } })).toThrow(/not available/);
    host.dispose();
  });

  test("no screenshot is ever offered: slides are text-only", () => { expect(createHost({}).assetUrl("x.jpg")).toBeNull(); });
});

describe("buildSteps", () => {
  const host = createHost({});
  const page = () => {
    // The page as it is after a mint and a present that answered as designed (take.py's own reading).
    document.body.innerHTML = `
      <p data-testid="sim-banner">Real: the tokens below are sent to the door.</p>
      <div data-testid="federation"><dl><dt>Issuer</dt><dd data-testid="v-issuer">https://issuer.example</dd>
      <dt>JwksURI</dt><dd data-testid="v-jwks">https://issuer.example/.well-known/jwks.json</dd></dl></div>
      <section data-testid="tokens"><p class="card__note">TEST tokens this lab signed: not issued by SPIRE, valid for 120 seconds.</p>
        <article data-testid="token-valid"><div data-testid="json-valid-box"><div class="jform__row"><dt>sub</dt><dd>spiffe://lab.example/ns/agents/sa/mcp-agent</dd></div></div></article>
        <article data-testid="token-mismatched"><div data-testid="json-mismatched-box"></div></article>
        <article data-testid="token-untrusted"><div data-testid="json-untrusted-box"></div></article>
      </section>
      <button data-testid="present">Present to the gateway</button>
      <table class="results" data-testid="results-table"><tbody>
        <tr data-testid="row-valid"><td>Valid</td><td data-testid="status-valid">200</td><td data-testid="words-valid">accepted: returned 7 tool(s) REAL</td></tr>
        <tr data-testid="row-mismatched"><td>Mismatched</td><td data-testid="status-mismatched">401</td><td data-testid="words-mismatched">Bearer token required REAL</td></tr>
        <tr data-testid="row-untrusted"><td>Untrusted</td><td data-testid="status-untrusted">401</td><td data-testid="words-untrusted">Unauthorized REAL</td></tr>
      </tbody></table>
      <details class="gw-ex" open><summary><strong>Valid token: tools/list</strong><span>HTTP 200</span></summary><div class="gw-io"><pre>request</pre></div></details>
      <details class="gw-ex"><summary><strong>Mismatched token: tools/list</strong></summary><div class="gw-io"></div></details>
      <section class="card" data-testid="run-record"><p data-testid="ro-summary">1 allowed</p></section>`;  };

  test("every step of the script is built (nothing held back)", () => {
    page();
    const steps = buildSteps({ captions, host });
    expect(steps.map((s) => s.key)).toEqual(STEPS.map((s) => s.key));
    expect(NOT_YET).toEqual([]);
  });

  test("targets: the payload boxes, the valid results row only when the page says accepted, the Valid exchange, the run record only with a record", () => {
    page();
    const by = Object.fromEntries(buildSteps({ captions, host }).map((s) => [s.key, s]));
    const t = (s) => (typeof s.target === "function" ? s.target() : document.querySelector(s.target));
    expect(by.intro.target).toBe("[data-testid=sim-banner]");
    expect(by.federation.target).toBe("[data-testid=federation]");
    expect(t(by.valid)).toBe(document.querySelector("[data-testid=json-valid-box]"));
    expect(t(by.mismatched)).toBe(document.querySelector("[data-testid=json-mismatched-box]"));
    expect(by.valid_result.target()).toBe(document.querySelector("[data-testid=row-valid]"));   // the page says accepted
    expect(by.trace.target().closest("details")).toBe(document.querySelector("details.gw-ex"));
    expect(by.trace.target().classList.contains("gw-io")).toBe(true);
    expect(by.observability_panel.target()).toBe(document.querySelector("[data-testid=ro-summary]"));   // the panel's own summary line, a narrow target
    // The refusal words come from the rows, first clause, chip word dropped
    expect(by.refused.lines()).toEqual(['Mismatched: "Bearer token required". Untrusted: "Unauthorized".']);
    expect(by.valid_result.lines()).toEqual(["HTTP 200", "7 tools came back"]);
    expect(by.valid.lines()).toEqual(["120 seconds"]);
  });

  test("a bubble that claims something the page does not show is skipped: not accepted, no record, wrong-phrase rows", () => {
    page();
    const by = Object.fromEntries(buildSteps({ captions, host }).map((s) => [s.key, s]));
    document.querySelector("[data-testid=words-valid]").textContent = "Bearer token required REAL";   // the gateway did not accept it
    expect(by.valid_result.target()).toBeNull();
    document.querySelector("[data-testid=words-valid]").textContent = "accepted REAL";
    expect(by.valid_result.lines()).toEqual(["HTTP 200", "accepted"]);   // the words it has, never an invented tool count
    document.querySelector("[data-testid=run-record]").innerHTML = '<p data-testid="ro-empty">Run the demo</p>';
    expect(by.observability_panel.target()).toBeNull();                                                 // no record: nothing to point at
    document.querySelector("[data-testid=run-record]").innerHTML = '<p data-testid="run-record-none">no run</p>';
    expect(by.observability_panel.target()).toBeNull();
    const noTrace = document.querySelector("details.gw-ex"); noTrace.remove();
    expect(by.trace.target()).toBeNull();                                                               // no trace exchange: skipped quietly
  });

  test("every step names a known trigger and type, and its Mock wording exists", () => {
    const keys = STEPS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of STEPS) {
      expect(["load", "run-done", "frame"]).toContain(s.trigger);
      expect(["bubble", "slide"]).toContain(s.type);
      if (s.sampleKey) expect(captions.steps[s.sampleKey], `${s.sampleKey} exists`).toBeTruthy();
    }
  });

  test("the Mock closing slide swaps in the simulated wording and never claims a live run; Real keeps the slide as written", () => {
    const closing = buildSteps({ captions, host }).find((s) => s.key === "closing");
    const mock = closing.transform(captions.closing, "mock"); const real = closing.transform(captions.closing, "real");
    expect(mock.lead).toBe("This sample ran the lab in Mock mode: one right token accepted, two wrong ones refused, by a stand-in.");
    expect(mock.colA.lines[0]).toBe("Presented each to the mock stand-in, not a gateway");
    expect(real).toBe(captions.closing);
  });

  test("the run record's empty and no-run states are guarded (an empty panel is never pointed at)", () => {
    page();
    const by = Object.fromEntries(buildSteps({ captions, host }).map((s) => [s.key, s]));
    document.querySelector("[data-testid=run-record]").innerHTML = "<p>results</p><p>record rows</p>";
    expect(by.observability_panel.target()).not.toBeNull();
  });
});
