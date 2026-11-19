import React from "react";
import GatewayTrace from "../gateway-trace/GatewayTrace.jsx";
import { visible } from "../safeText.js";

// One row per token: the HTTP status and the gateway's own words. A row is "as designed" only when the status is the one the lab expects;
// a gateway configured differently may answer differently, and the table says so rather than hiding it.
export default function Results({ run, real, busy, onPresent }) {
  const rows = run?.rows || [];
  return (
    <section data-testid="results">
      <div className="section-head">
        <h2 className="section-head__title"><span className="step-num" aria-hidden="true">4</span>Present to the gateway</h2>
        <button type="button" className="primary" data-testid="present" disabled={busy} onClick={onPresent}>
          {busy ? "Presenting…" : real ? "Present to the gateway" : "Rehearse against the mock gateway"}
        </button>
      </div>
      <p className="card__note">
        {real ? "Each token is sent as the bearer to the door: initialize, then tools/list." : "Mock: an in-process stand-in applies the same checks to the published JWKS. Not a Privilege result."}
      </p>
      {rows.length > 0 && (
        <>
          <div className="scroll">
            <table className="results" data-testid="results-table">
              <caption className="sr-only">What the gateway answered for each token</caption>
              <thead><tr><th>Token</th><th>HTTP status</th><th>The gateway&apos;s words</th><th>Expected</th><th>Result</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} data-testid={`row-${r.id}`}>
                    <td><strong>{r.label}</strong><br /><code className="results__sub">{visible(r.sub)}</code></td>
                    <td data-testid={`status-${r.id}`}>{r.status ?? "no answer"}</td>
                    <td data-testid={`words-${r.id}`}>{visible(r.words)} <span className="chip">{r.source === "mock" ? "MOCK" : "REAL"}</span></td>
                    <td>{r.expect}</td>
                    <td><span className={`chip ${r.matched ? "chip--ok" : "chip--warn"}`}>{r.matched ? "as designed" : "not as designed"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <GatewayTrace
            source={real ? "real" : "mock"}
            exchanges={rows.map((r, i) => ({ step: i + 1, title: `${r.label} token: tools/list`, status: r.status, trace: r.trace }))}
            hot={["error", "isError"]}
            basisNote={real ? undefined : "This is the lab's own mock gateway, so its decisions are computed here, not reported by Privilege."}
          />
        </>
      )}
    </section>
  );
}
