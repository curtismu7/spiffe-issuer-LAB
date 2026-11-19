import React, { useCallback, useEffect, useState } from "react";
import { visible } from "../safeText.js";

// "SPIRE server control" card: test / start / restart an optional local demo SPIRE container, or test a SPIRE you run yourself
// (SPIRE_SERVER_URL), and a step-by-step guide to setting one up on your side. The lab itself is a token minter, not SPIRE.
const Chip = ({ ok, children }) => <span className={`chip ${ok ? "chip--ok" : "chip--warn"}`}>{children}</span>;

const MODE_LABEL = { local: "Local demo SPIRE (Docker on this machine)", remote: "Your own SPIRE", invalid: "SPIRE_SERVER_URL is invalid" };

export default function SpireCard({ busy, setBusy, onError }) {
  const [command, setCommand] = useState(null);
  const [guide, setGuide] = useState(null);
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
    fetch("/api/spire/guide").then((r) => (r.ok ? r.json() : null)).then((g) => { if (live && g && Array.isArray(g.steps)) setGuide(g); }).catch(() => {});
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
      if (kind === "start" && r.body?.test) setTestResult(r.body.test);
    } catch (e) {
      onError(String(e.message || e));
    } finally { setBusy(false); setCardBusy(null); }
  };

  const mode = testResult ? testResult.tested : (guide?.mode || "local");
  const isLocal = mode === "local";
  const failed = testResult && !testResult.ok;
  const busyLabel = (kind, label) => (cardBusy === kind ? "Working…" : label);
  const locked = busy || Boolean(cardBusy);

  return (
    <div className="card card--neutral" data-testid="spire-card">
      <h2 className="card__title">SPIRE server control <Chip ok={testResult ? testResult.ok : null}>{testResult ? (testResult.ok ? "pass" : "fail") : "not tested"}</Chip></h2>
      <p className="card__note">This lab signs its own test JWT-SVIDs; it is not SPIRE. Run a throwaway SPIRE on loopback with Docker to see what a real one looks like, or point the test at a SPIRE you run yourself with <code>SPIRE_SERVER_URL</code> in this lab's <code>.env</code> (a path prefix such as <code>https://spire.example/spire</code> is fine).</p>
      <p className="card__note" data-testid="spire-mode">Testing: <strong>{MODE_LABEL[mode] || mode}</strong>{mode === "remote" && guide?.serverUrl ? <> <code>{visible(guide.serverUrl)}</code></> : null}</p>
      {guide?.problems?.length > 0 && <p className="field-error" role="alert" data-testid="spire-settings-problems">{visible(guide.problems.join("; "))}</p>}
      <div className="spire-actions">
        <button type="button" data-testid="spire-test" disabled={locked} onClick={run("test", "/api/spire/test")}>{busyLabel("test", "Test SPIRE server")}</button>
        <button type="button" data-testid="spire-start" disabled={locked || !failed || !isLocal} title={isLocal ? undefined : "Your own SPIRE is being tested: this card starts nothing"} onClick={run("start", "/api/spire/start")}>{busyLabel("start", "Start SPIRE")}</button>
        <button type="button" data-testid="spire-restart" disabled={locked || !isLocal} title={isLocal ? undefined : "Your own SPIRE is being tested: this card restarts nothing"} onClick={run("restart", "/api/spire/restart")}>{busyLabel("restart", "Restart SPIRE")}</button>
      </div>
      {command && isLocal && <p className="card__note" data-testid="spire-command">The start command (loopback only): <code>{visible(command)}</code></p>}
      {startState && !startState.ok && startState.reason === "docker-unavailable" && (
        <p className="notice" data-testid="spire-docker-unavailable" role="alert">Docker is not reachable from the lab, so no local SPIRE can be started. The lab keeps minting its own test tokens.</p>
      )}
      {startState && !startState.ok && startState.reason === "not-local" && (
        <p className="notice" data-testid="spire-not-local" role="alert">{visible(startState.message)}</p>
      )}
      {startState && !startState.ok && startState.reason !== "docker-unavailable" && startState.reason !== "not-local" && (
        <p className="field-error" role="alert" data-testid="spire-start-error">Start/restart did not come up healthy. Run Test for the per-check detail.</p>
      )}
      {startState?.ok && <p className="card__note" data-testid="spire-start-ok">SPIRE container started and ready.</p>}
      {testResult && (
        <>
          <div className="spire-table">
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
          </div>
          {testResult.tested === "remote" && (
            <p className="card__note" data-testid="spire-remote-caveat">A pass means the keys are published, fetchable, well-formed and hold no private material. It cannot prove the server is SPIRE: check that the key algorithm and the issuer shown match what you expect. What proves the whole chain is a real token the gateway accepts (the last step below).</p>
          )}
        </>
      )}
      {guide && (
        <details className="spire-guide" data-testid="spire-guide">
          <summary>Set up SPIRE on your side</summary>
          <p className="card__note" data-testid="spire-verified">{visible(guide.verified)}</p>
          <ol>
            {guide.steps.map((s) => (
              <li key={s.id} data-testid={`spire-step-${s.id}`}>
                <strong>{visible(s.title)}</strong>
                {s.body.map((p, i) => <p key={i}>{visible(p)}</p>)}
                {s.code.length > 0 && <pre className="spire-code" tabIndex={0}>{visible(s.code.join("\n"))}</pre>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
