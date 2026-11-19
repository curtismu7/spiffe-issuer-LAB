import React, { useCallback, useEffect, useState } from "react";
import { visible } from "../safeText.js";

// "SPIRE server control" card: choose the Docker demo SPIRE or your cluster one (SPIRE_SERVER_URL), then test it (and, for Docker, start/restart it),
// plus a step-by-step guide to setting one up on your side. The lab itself is a token minter, not SPIRE.
const Chip = ({ ok, children }) => <span className={`chip ${ok ? "chip--ok" : "chip--warn"}`}>{children}</span>;

const TARGET_LABEL = { docker: "Docker demo SPIRE (on this machine)", cluster: "Cluster SPIRE (Kubernetes, your own)" };

export default function SpireCard({ busy, setBusy, onError }) {
  const [command, setCommand] = useState(null);
  const [kubectl, setKubectl] = useState([]);
  const [view, setView] = useState(null); // GET /api/spire/target: { target, serverUrl, options }
  const [guide, setGuide] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [startState, setStartState] = useState(null);
  const [cardBusy, setCardBusy] = useState(null); // "test" | "start" | "restart"

  const post = useCallback(async (path, payload = {}) => {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    let body = {};
    try { body = await r.json(); } catch { /* not JSON */ }
    return { ok: r.ok, status: r.status, body };
  }, []);

  const loadGuide = useCallback(() => (
    fetch("/api/spire/guide").then((r) => (r.ok ? r.json() : null)).then((g) => { if (g && Array.isArray(g.steps)) setGuide(g); }).catch(() => {})
  ), []);

  useEffect(() => {
    let live = true;
    fetch("/api/spire/command").then((r) => r.json()).then((c) => { if (live) { setCommand(c.command); setKubectl(Array.isArray(c.kubectl) ? c.kubectl : []); } }).catch(() => {});
    fetch("/api/spire/target").then((r) => (r.ok ? r.json() : null)).then((v) => { if (live && v && v.target) setView(v); }).catch(() => {});
    loadGuide();
    return () => { live = false; };
  }, [loadGuide]);

  const choose = async (next) => {
    if (busy || cardBusy || next === target) return;
    setBusy(true); setCardBusy("target"); onError(null);
    try {
      const r = await post("/api/spire/target", { target: next });
      if (!r.ok) { onError(r.body?.message || "Could not switch the SPIRE target."); return; }
      setView(r.body); setTestResult(null); setStartState(null);
      await loadGuide();
    } catch (e) {
      onError(String(e.message || e));
    } finally { setBusy(false); setCardBusy(null); }
  };

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

  // Without the target endpoint (older lab, failed request) fall back to what the guide says the settings imply.
  const target = view?.target ?? guide?.target ?? (!guide || guide.mode === "local" ? "docker" : "cluster");
  const isLocal = target === "docker";
  const serverUrl = view?.serverUrl ?? guide?.serverUrl ?? null;
  const clusterOption = view?.options?.cluster ?? { available: Boolean(serverUrl), reason: serverUrl ? null : "SPIRE_SERVER_URL is not set in this lab's .env" };
  const failed = testResult && !testResult.ok;
  const busyLabel = (kind, label) => (cardBusy === kind ? "Working…" : label);
  const locked = busy || Boolean(cardBusy);

  return (
    <div className="card card--neutral" data-testid="spire-card">
      <h2 className="card__title">SPIRE server control <Chip ok={testResult ? testResult.ok : null}>{testResult ? (testResult.ok ? "pass" : "fail") : "not tested"}</Chip></h2>
      <p className="card__note">This lab signs its own test JWT-SVIDs; it is not SPIRE. Choose which SPIRE to check: a throwaway one in Docker on this machine, or the one in your cluster, set with <code>SPIRE_SERVER_URL</code> in this lab's <code>.env</code> (a path prefix such as <code>https://spire.example/spire</code> is fine).</p>
      <div className="spire-target" data-testid="spire-target">
        <span id="spire-target-label" className="spire-target__label">SPIRE to use</span>
        <span className="mode-toggle" role="group" aria-labelledby="spire-target-label">
          <button type="button" data-testid="spire-target-docker" aria-pressed={isLocal} disabled={locked} onClick={() => choose("docker")}>Docker</button>
          <button type="button" data-testid="spire-target-cluster" aria-pressed={!isLocal} disabled={locked || !clusterOption.available} title={clusterOption.available ? undefined : clusterOption.reason} onClick={() => choose("cluster")}>Cluster (K8)</button>
        </span>
      </div>
      {!clusterOption.available && <p className="card__note" data-testid="spire-cluster-off">Cluster is off: {visible(clusterOption.reason)}.</p>}
      <p className="card__note" data-testid="spire-mode">Testing: <strong>{TARGET_LABEL[target]}</strong>{!isLocal && serverUrl ? <> <code>{visible(serverUrl)}</code></> : null}{!isLocal && guide?.mode === "invalid" ? " (SPIRE_SERVER_URL is invalid)" : null}</p>
      {guide?.problems?.length > 0 && <p className="field-error" role="alert" data-testid="spire-settings-problems">{visible(guide.problems.join("; "))}</p>}
      <div className="spire-actions">
        <button type="button" data-testid="spire-test" disabled={locked} onClick={run("test", "/api/spire/test")}>{busyLabel("test", "Test SPIRE server")}</button>
        <button type="button" data-testid="spire-start" disabled={locked || !failed || !isLocal} title={isLocal ? undefined : "The cluster SPIRE is selected: this lab holds no cluster credentials, so it starts nothing there"} onClick={run("start", "/api/spire/start")}>{busyLabel("start", "Start SPIRE")}</button>
        <button type="button" data-testid="spire-restart" disabled={locked || !isLocal} title={isLocal ? undefined : "The cluster SPIRE is selected: this lab holds no cluster credentials, so it restarts nothing there"} onClick={run("restart", "/api/spire/restart")}>{busyLabel("restart", "Restart SPIRE")}</button>
      </div>
      {command && isLocal && <p className="card__note" data-testid="spire-command">The start command (loopback only): <code>{visible(command)}</code></p>}
      {!isLocal && kubectl.length > 0 && (
        <div className="spire-kubectl" data-testid="spire-kubectl">
          <p className="card__note">To start or restart the cluster SPIRE, run these yourself with your own cluster access (replace <code>&lt;namespace&gt;</code>). This lab holds no cluster credentials and never runs them.</p>
          <ul>
            {kubectl.map((k) => (
              <li key={k.label}><span>{visible(k.label)}</span><pre className="spire-code" tabIndex={0}>{visible(k.command)}</pre></li>
            ))}
          </ul>
        </div>
      )}
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
