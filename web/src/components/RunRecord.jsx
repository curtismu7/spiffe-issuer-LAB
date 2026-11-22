import React, { useEffect, useRef, useState } from "react";
import RunObservability from "../run-observability/RunObservability.jsx";

// Rule 27: the run's record under the lab's result, drawn by the shared panel. The server builds the record (GET /api/run-observability) in the
// page's current mode; this asks again whenever a run finished or failed (`runKey`) or the mode changed, and says what the answer is.
const LANE = "Agent gateway lane here: in Mock, the lab's own rehearsal gateway; in Real, the reply the lab received from the gateway you configured, not a gateway log line. The time on each row is when the lab computed the decision.";
const STREAMS = [{
  product: "This lab (server)",
  lives: "container stdout: one line per decision (the SPIFFE ID, the HTTP status, the result), never a token",
  streams: "nothing by default; the family collector can ship container stdout to demo-logs-<service> and on to a SIEM. This panel does not read that stream back",
}];

export default function RunRecord({ source, runKey }) {
  const [state, setState] = useState({ loading: true });
  const seq = useRef(0);
  const known = source === "mock" || source === "real";

  useEffect(() => {
    if (!known) return undefined;
    const mine = ++seq.current;
    if (runKey === null) { setState({ noRun: true }); return undefined; } // the last attempt began no run: never show an older record under it
    setState({ loading: true });
    (async () => {
      let next;
      try {
        const r = await fetch("/api/run-observability");
        const body = await r.json();
        next = r.ok && body && "record" in body ? { record: body.record, message: body.message } : { record: { error: body?.error ?? "bad_answer", message: body?.message ?? "The lab's server gave an answer the page cannot read." } };
      } catch { next = { record: { error: "network_error", message: "The lab's server did not answer." } }; }
      if (mine === seq.current) setState(next); // a newer read owns the panel
    })();
    return () => { seq.current += 1; };
  }, [source, runKey, known]);

  if (!known) return null;
  return (
    <section className="card" data-testid="run-record">
      {state.loading ? <p className="hint" data-testid="run-record-loading">Reading this run's record.</p>
        : state.noRun ? <p data-testid="run-record-none">That attempt began no run, so there is no record for it.</p>
        : (
          <>
            <RunObservability record={state.record} source={source} streams={STREAMS} />
            {state.record === null ? <p className="hint" data-testid="run-record-message">{state.message}</p> : null}
            <p className="hint" data-testid="run-lane-note">{LANE}</p>
          </>
        )}
    </section>
  );
}
