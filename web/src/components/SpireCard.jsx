import React, { useCallback, useEffect, useState } from "react";
import { visible } from "../safeText.js";

// "SPIRE server control" card: test / start / restart an optional local SPIRE server container,
// or probe a configured remote discovery base. The lab itself is a token minter, not SPIRE.
const Chip = ({ ok, children }) => <span className={`chip ${ok ? "chip--ok" : "chip--warn"}`}>{children}</span>;

export default function SpireCard({ busy, setBusy, onError }) {
  const [command, setCommand] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [startState, setStartState] = useState(null);
  const [cardBusy, setCardBusy] = useState(null); // "test" | "start" | "restart"

  const post = useCallback(async (path) => {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    let body = {};
    try { body = await r.json(); } catch { /* not JSON */ }
    return { ok: r.ok, status: r.status, body };
  }, []);

  useEffect(() => {
    let live = true;
    fetch("/api/spire/command").then((r) => r.json()).then((c) => { if (live) setCommand(c.command); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const run = (kind, path) => async () => {
    if (busy || cardBusy) return;
    setBusy(true); setCardBusy(kind); onError(null);
    try {
      if (kind === "test" || kind === "restart") setTestResult(null);
      if (kind === "start" || kind === "restart") setStartState(null);
      const r = await post(path);
      if (kind === "test") setTestResult(r.body);
      else setStartState(r.body);
      if (kind === "restart" && r.body?.test) setTestResult(r.body.test);
    } catch (e) {
      onError(String(e.message || e));
    } finally { setBusy(false); setCardBusy(null); }
  };

  const failed = testResult && !testResult.ok;
  const local = !testResult || testResult.tested === "local";
  const busyLabel = (kind, label) => (cardBusy === kind ? "Working…" : label);

  return (
    <div className="card card--neutral" data-testid="spire-card">
      <h2 className="card__title"><span className="step-num" aria-hidden="true">2</span>SPIRE server control <Chip ok={testResult ? testResult.ok : null}>{testResult ? (testResult.ok ? "pass" : "fail") : "not tested"}</Chip></h2>
      <p className="card__note">This lab signs its own test JWT-SVIDs; it is not SPIRE. Optionally run a real SPIRE server on loopback with Docker, or point the test at a remote discovery base via <code>SPIRE_SERVER_URL</code> / <code>SPIRE_AGENT_URL</code>.</p>
      <div className="spire-actions">
        <button type="button" data-testid="spire-test" disabled={busy || Boolean(cardBusy)} onClick={run("test", "/api/spire/test")}>{busyLabel("test", "Test SPIRE server")}</button>
        <button type="button" data-testid="spire-start" disabled={busy || Boolean(cardBusy) || !failed || !local} onClick={run("start", "/api/spire/start")}>{busyLabel("start", "Start SPIRE")}</button>
        <button type="button" data-testid="spire-restart" disabled={busy || Boolean(cardBusy)} onClick={run("restart", "/api/spire/restart")}>{busyLabel("restart", "Restart SPIRE")}</button>
      </div>
      {command && <p className="card__note" data-testid="spire-command">The start command (loopback only): <code>{visible(command)}</code></p>}
      {startState && !startState.ok && startState.reason === "docker-unavailable" && (
        <p className="notice" data-testid="spire-docker-unavailable" role="alert">Docker is not reachable from the lab, so no local SPIRE can be started. The lab keeps minting its own test tokens.</p>
      )}
      {startState && !startState.ok && startState.reason !== "docker-unavailable" && (
        <p className="field-error" role="alert" data-testid="spire-start-error">Start/restart did not come up healthy. Run Test for the per-check detail.</p>
      )}
      {startState?.ok && <p className="card__note" data-testid="spire-start-ok">SPIRE container started.</p>}
      {testResult && (
        <table className="results" data-testid="spire-checks">
          <thead><tr><th>Check</th><th>Result</th><th>Detail</th><th>ms</th></tr></thead>
          <tbody>
            {testResult.checks.map((c) => (
              <tr key={c.name} data-testid={`spire-check-${c.name}`}>
                <td>{c.name}</td>
                <td><Chip ok={c.ok}>{c.ok ? "pass" : "fail"}</Chip></td>
                <td>{visible(c.detail)}</td>
                <td>{String(c.ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
