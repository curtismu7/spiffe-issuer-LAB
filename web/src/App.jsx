import React, { lazy, Suspense, useCallback, useEffect, useState, useRef } from "react";
import TopMenu from "./top-menu/TopMenu.jsx";
import StoryToggle, { storyKey } from "./story/StoryToggle.jsx";
import ShelfLink from "./components/ShelfLink.jsx";
import Settings from "./components/Settings.jsx";
import SpireCard from "./components/SpireCard.jsx";
import TokenCards from "./components/TokenCards.jsx";
import Results from "./components/Results.jsx";
import RunRecord from "./components/RunRecord.jsx";
import HelpCard from "./components/HelpCard.jsx";

// Story mode is loaded only when the viewer switches it on, so the page in Demo mode does not pay for it.
const StoryRoot = lazy(() => import("./StoryRoot.jsx"));
export const STORY_PREFIX = "spiffe";

// If the Story chunk cannot load (the lab was rebuilt, a stale file name, the network) the shell bar must survive: Demo mode is never taken down by Story.
class StoryBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="story-bar" role="alert" data-testid="story-error">
        <span className="story-msg">Story could not load. Reload the page and try again.</span>
        <button type="button" onClick={this.props.onExit}>Exit</button>
      </div>
    );
  }
}

const REPO = "https://github.com/curtismu7/spiffe-issuer-LAB#readme";
const PF_GUIDE = "https://github.com/curtismu7/spiffe-issuer-LAB/blob/main/docs/pf-setup-guide/pingfederate-spire-setup-guide.pdf";
const post = async (url, payload) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
};

export default function App() {
  const [info, setInfo] = useState(null);
  const runEndRaf = useRef(null); // the pending run-end rAF (the inner frame of the two): cancelled on unmount, so a gone page dispatches nothing
  const [app, setApp] = useState(null);
  const [tokens, setTokens] = useState(null);
  const [run, setRun] = useState(null);
  const [runKey, setRunKey] = useState(0); // changes when a present finished; null when the last attempt began no run (rule 27 panel)
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem("theme") || "auto"; } catch { return "auto"; } });
  const [storyOn, setStoryOn] = useState(false);
  const [toggleKey, setToggleKey] = useState(0);
  const writeStore = (key, value) => { try { localStorage.setItem(key, value); } catch { /* not remembered */ } };

  useEffect(() => {
    document.documentElement.dataset.theme = theme === "auto" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
    try { localStorage.setItem("theme", theme); } catch { /* storage blocked */ }
  }, [theme]);

  const mint = useCallback(async (door) => {
    const r = await post("/api/mint", { app: door ?? undefined });
    if (r.ok) setTokens(r.body); else setError(r.body.message || r.body.error || `HTTP ${r.status}`);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/info");
      const i = await r.json();
      setInfo(i);
      setApp(i.config.app);
      await mint(i.config.app);
      setError(null);
    } catch (e) { setError(String(e.message || e)); }
  }, [mint]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { if (runEndRaf.current != null) cancelAnimationFrame(runEndRaf.current); }, []); // a page taken down stops its pending run-end

  const setMode = async (source) => {
    const r = await post("/api/mode", { source });
    if (r.ok) { setInfo((i) => ({ ...i, source })); setRun(null); setRunKey(0); }
    return r.ok;
  };

  const chooseApp = async (door) => { setApp(door); setRun(null); await mint(door); };

  const present = async () => {
    setBusy(true); setError(null);
    window.dispatchEvent(new CustomEvent("spiffe:run-start"));
    try {
      const r = await post("/api/present", { app: app ?? undefined });
      // A 502 still carries rows and a named message (the gateway could not be reached); a 409 carries what is missing.
      if (r.body.rows) { setRun(r.body); setTokens(r.body); }
      // A present that the gateway refused (401 rows) or that could not reach the gateway (502 with rows) completed: the rows show it.
      // Only a refusal before any run (a 4xx without rows) is a request-level failure: ok is false.
      const requestFailed = !r.body.rows && r.status >= 400;
      // run-end goes out AFTER the rows are on the page (the next frame): the Story steps that wait for the run read the rows as soon as it ends.
      if (requestFailed) window.dispatchEvent(new CustomEvent("spiffe:run-end", { detail: { ok: false } }));
      else runEndRaf.current = requestAnimationFrame(() => { runEndRaf.current = requestAnimationFrame(() => { runEndRaf.current = null; window.dispatchEvent(new CustomEvent("spiffe:run-end", { detail: { ok: true } })); }); });
      // Only a refusal before any run (a 4xx without rows) began no run; anything else may have logged one, so read again.
      setRunKey((k) => (!r.body.rows && r.status >= 400 && r.status < 500 ? null : (k ?? 0) + 1));
      if (!r.ok) setError(r.body.message || r.body.error || `HTTP ${r.status}`);
    } catch (e) { setError(String(e.message || e)); window.dispatchEvent(new CustomEvent("spiffe:run-end", { detail: { ok: false } })); setRunKey((k) => (k ?? 0) + 1); } finally { setBusy(false); }
  };

  // Exit in the Story bar: back to Demo, remembered, and ?story=1 dropped from the address so a reload stays in Demo.
  const leaveStory = useCallback(() => {
    writeStore(storyKey(STORY_PREFIX), "demo");
    try { const u = new URL(window.location.href); if (u.searchParams.has("story")) { u.searchParams.delete("story"); window.history.replaceState(null, "", u); } } catch { /* no address to tidy */ }
    setToggleKey((k) => k + 1);
  }, []);

  if (!info) return error ? <p className="app-error">The lab could not start: {error}</p> : <p className="muted">Loading…</p>;
  const real = info.source === "real";
  const c = info.config;

  return (
    <div className="app">
      <header className="shell-bar">
        <span className="shell-brand">
          <span className="shell-logo">ID</span>
          SPIFFE Issuer LAB
          <span className={`shell-badge ${real ? "shell-badge--real" : ""}`} data-testid="mode-badge">{info.source}</span>
        </span>
        <TopMenu
          mode={{ value: info.source, onChange: setMode, realAvailable: info.realAvailable, realHint: info.realHint }}
          theme={{ value: theme, onChange: setTheme }}
          help={{ href: REPO }}
          version={info.version ? `v${info.version}` : undefined}
          extra={<StoryToggle key={toggleKey} prefix={STORY_PREFIX} onChange={setStoryOn} />}
        >
          <a className="shelf-link" href={PF_GUIDE} target="_blank" rel="noreferrer" title="How to accept SPIRE JWT-SVIDs in your own PingFederate (PDF, three modes)">PF guide</a>
          <ShelfLink />
        </TopMenu>
      </header>
      {storyOn ? (
        <StoryBoundary onExit={leaveStory}>
          <Suspense fallback={null}>
            <StoryRoot mode={real ? "real" : "mock"} ready onExit={leaveStory} prefix={STORY_PREFIX} />
          </Suspense>
        </StoryBoundary>
      ) : null}
      <main className="page">
        <p className="banner" role="note" data-testid="sim-banner" data-state={real ? "live" : undefined}>
          {real
            ? `Real: the tokens below are sent to ${c.gatewayOrigin} and only that origin. Only a real gateway answer counts here. The tokens are TEST tokens this lab minted and signed itself; it is not SPIRE and attests no workload.`
            : "Mock: this lab MINTS test JWT-SVIDs with a key it generated itself. It is not SPIRE and attests no workload. The gateway below is an in-process rehearsal, labelled MOCK: it is never a Privilege result. Switch to Real to present the tokens to your gateway."}
        </p>
        <h1 className="page__title">SPIFFE agent identity: valid, mismatched, untrusted</h1>
        <p className="intro">Mints three short-lived JWT-SVIDs, publishes the public key a gateway can fetch, and presents each token to an MCP door. Expected: the valid one is accepted, the mismatched and untrusted ones are refused.</p>
        {error && <p className="field-error" role="alert" data-testid="error">{error}</p>}
        {info.realHint && <p className="notice" data-testid="real-hint">{info.realHint}</p>}
        <Settings config={c} app={app} audience={tokens?.audience} onApp={chooseApp} />
        <SpireCard busy={busy} setBusy={setBusy} onError={setError} />
        <TokenCards tokens={tokens?.tokens} config={c} onMint={() => mint(app)} />
        <Results run={run} real={real} busy={busy} onPresent={present} />
        <RunRecord source={info.source} runKey={runKey} />
        <HelpCard />
      </main>
    </div>
  );
}
