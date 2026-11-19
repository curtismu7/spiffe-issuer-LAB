import React, { useCallback, useEffect, useState } from "react";
import TopMenu from "./top-menu/TopMenu.jsx";
import ShelfLink from "./components/ShelfLink.jsx";
import Settings from "./components/Settings.jsx";
import SpireCard from "./components/SpireCard.jsx";
import TokenCards from "./components/TokenCards.jsx";
import Results from "./components/Results.jsx";

const REPO = "https://github.com/curtismu7/spiffe-issuer-LAB#readme";
const post = async (url, payload) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
};

export default function App() {
  const [info, setInfo] = useState(null);
  const [app, setApp] = useState(null);
  const [tokens, setTokens] = useState(null);
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem("theme") || "auto"; } catch { return "auto"; } });

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

  const setMode = async (source) => {
    const r = await post("/api/mode", { source });
    if (r.ok) { setInfo((i) => ({ ...i, source })); setRun(null); }
    return r.ok;
  };

  const chooseApp = async (door) => { setApp(door); setRun(null); await mint(door); };

  const present = async () => {
    setBusy(true); setError(null);
    try {
      const r = await post("/api/present", { app: app ?? undefined });
      // A 502 still carries rows and a named message (the gateway could not be reached); a 409 carries what is missing.
      if (r.body.rows) { setRun(r.body); setTokens(r.body); }
      if (!r.ok) setError(r.body.message || r.body.error || `HTTP ${r.status}`);
    } catch (e) { setError(String(e.message || e)); } finally { setBusy(false); }
  };

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
        >
          <ShelfLink />
        </TopMenu>
      </header>
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
      </main>
    </div>
  );
}
