import React, { useState } from "react";
import Json from "./JsonPane.jsx";

const EXPECT = { valid: "Expected: the gateway accepts it (HTTP 200).", mismatched: "Expected: the gateway refuses it (HTTP 401).", untrusted: "Expected: the gateway refuses it (HTTP 401)." };

// Copy never logs: the token goes to the clipboard and nowhere else.
function CopyButton({ token, id }) {
  const [state, setState] = useState("");
  const copy = async () => {
    try { await navigator.clipboard.writeText(token); setState("Copied"); } catch { setState("Select the text and copy"); }
    setTimeout(() => setState(""), 2000);
  };
  return (
    <>
      <button type="button" data-testid={`copy-${id}`} onClick={copy} aria-label={`Copy the ${id} token`}>Copy token</button>
      <span className="card__note" role="status" data-testid={`copied-${id}`}>{state}</span>
    </>
  );
}

export default function TokenCards({ tokens, config, onMint }) {
  return (
    <section data-testid="tokens">
      <div className="section-head">
        <h2 className="section-head__title"><span className="step-num" aria-hidden="true">3</span>The three tokens</h2>
        <button type="button" data-testid="mint" onClick={onMint}>Mint fresh tokens</button>
      </div>
      <p className="card__note">TEST tokens this lab signed: not issued by SPIRE, valid for {config.ttlSeconds} seconds. The private keys are never shown.</p>
      <div className="grid grid--tokens">
        {(tokens || []).map((t) => (
          <article key={t.id} className={`card ${t.id === "valid" ? "card--ok" : "card--bad"}`} data-testid={`token-${t.id}`}>
            <h3 className="card__title">{t.label} <span className="chip">{t.expect === 200 ? "should be accepted" : "should be refused"}</span></h3>
            <p className="card__note">{t.id === "untrusted" && config.untrustedMode === "issuer" ? "The valid SPIFFE ID, from a different issuer, signed by a key that is never published." : t.why} {EXPECT[t.id]}</p>
            <CopyButton token={t.token} id={t.id} />
            <Json value={{ token: t.token }} label={`${t.label} token, decoded`} testId={`json-${t.id}`} hot={["sub", "aud", "iss", "kid"]} />
          </article>
        ))}
      </div>
    </section>
  );
}
