// Rule 27 on the lab's page: the empty state with the route's message, a loading state that is not the empty state, the Mock record, a record of the
// other mode refused, a failed collection as an alert, a re-read after a run (even a failed one) and on a mode change, and a stale answer never wins.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import RunRecord from "./RunRecord.jsx";
import { setJsonView } from "./JsonPane.jsx";
import { mockRecord, realRecord } from "../run-observability/fixtures.js";

let reply;
let calls;
const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
beforeEach(() => {
  setJsonView("raw");
  calls = [];
  reply = () => json({ record: null, message: "No Mock run yet. Press the button." });
  vi.stubGlobal("fetch", vi.fn(async (url) => { calls.push(String(url)); return String(url) === "/api/run-observability" ? reply() : json({}, 404); }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("RunRecord", () => {
  it("shows a loading state, not the empty state, while it reads; then the empty state with the route message", async () => {
    let release;
    reply = () => new Promise((resolve) => { release = () => resolve(json({ record: null, message: "No Mock run yet." })); });
    render(<RunRecord source="mock" runKey={0} />);
    expect(screen.getByTestId("run-record-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("ro-empty")).toBeNull();
    release();
    expect(await screen.findByTestId("ro-empty")).toBeInTheDocument();
    expect(screen.getByTestId("run-record-message")).toHaveTextContent("No Mock run yet.");
    expect(screen.getByTestId("run-lane-note")).toHaveTextContent(/not a gateway log line/);
    expect(screen.getByTestId("run-lane-note")).toHaveTextContent(/when the lab computed the decision/);
  });

  it("asks nothing and draws nothing until the page knows its mode", () => {
    render(<RunRecord source={undefined} runKey={0} />);
    expect(calls).toEqual([]);
    expect(screen.queryByTestId("run-record")).toBeNull();
  });

  it("Mock: simulated rows, no Re-read button (this lab reads no log), and the stream block names this lab", async () => {
    reply = () => json({ record: mockRecord });
    render(<RunRecord source="mock" runKey={1} />);
    expect(await screen.findByTestId("ro-table")).toBeInTheDocument();
    expect(screen.getByTestId("ro-coverage-person")).toHaveTextContent("Simulated");
    expect(screen.queryByTestId("ro-reread")).toBeNull();
    expect(screen.getByTestId("ro-streams")).toHaveTextContent(/This lab \(server\)/);
  });

  it("a record from the other mode is refused on screen, and a failed collection is an alert", async () => {
    reply = () => json({ record: realRecord });
    render(<RunRecord source="mock" runKey={1} />);
    expect(await screen.findByTestId("ro-mismatch")).toBeInTheDocument();
    cleanup();
    reply = () => json({ error: "bad_window", message: "startedAt is not a time between the years 2000 and 2100." }, 400);
    render(<RunRecord source="mock" runKey={1} />);
    expect(await screen.findByTestId("ro-error")).toHaveTextContent(/between the years 2000 and 2100/);
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    render(<RunRecord source="mock" runKey={1} />);
    expect(await screen.findByTestId("ro-error")).toHaveTextContent(/did not answer/);
  });

  it("reads again when a run finished and when the mode switches, in both directions", async () => {
    reply = () => json({ record: mockRecord });
    const { rerender } = render(<RunRecord source="mock" runKey={1} />);
    await screen.findByTestId("ro-table");
    expect(calls.length).toBe(1);
    rerender(<RunRecord source="mock" runKey={2} />);
    await waitFor(() => expect(calls.length).toBe(2));
    reply = () => json({ record: realRecord });
    rerender(<RunRecord source="real" runKey={2} />);
    await waitFor(() => expect(calls.length).toBe(3));
    await waitFor(() => expect(screen.getByTestId("ro-coverage-person")).toHaveTextContent("Logged"));
    reply = () => json({ record: mockRecord });
    rerender(<RunRecord source="mock" runKey={2} />);
    await waitFor(() => expect(screen.getByTestId("ro-coverage-person")).toHaveTextContent("Simulated"));
  });

  it("an attempt that began no run says so and reads nothing, instead of showing an older record", async () => {
    reply = () => json({ record: mockRecord });
    const { rerender } = render(<RunRecord source="mock" runKey={1} />);
    await screen.findByTestId("ro-table");
    const before = calls.length;
    rerender(<RunRecord source="mock" runKey={null} />);
    expect(await screen.findByTestId("run-record-none")).toHaveTextContent(/began no run/);
    expect(screen.queryByTestId("ro-table")).toBeNull();
    expect(calls.length).toBe(before);
  });

  it("a slow answer for an earlier read never replaces the newer one", async () => {
    const waiting = [];
    reply = () => new Promise((resolve) => waiting.push(resolve));
    const { rerender } = render(<RunRecord source="mock" runKey={1} />);
    rerender(<RunRecord source="mock" runKey={2} />);
    await waitFor(() => expect(waiting.length).toBe(2));
    waiting[1](json({ record: mockRecord }));
    await screen.findByTestId("ro-table");
    waiting[0](json({ record: null, message: "stale" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("ro-table")).toBeInTheDocument();
    expect(screen.queryByTestId("run-record-message")).toBeNull();
  });
});
