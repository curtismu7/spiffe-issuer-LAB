import React from "react";
import { visible } from "../safeText.js";

const Row = ({ k, children, testId }) => (<><dt>{k}</dt><dd data-testid={testId}>{children}</dd></>);
const Mono = ({ children }) => <code>{visible(children)}</code>;

// The settings the lab will use, and the four values to type into the Privilege Federated Identity. No secret exists here:
// the signing keys never leave the server.
export default function Settings({ config: c, app, audience, onApp }) {
  return (
    <section className="grid">
      <div className="card" data-testid="federation">
        <h2 className="card__title"><span className="step-num" aria-hidden="true">1</span>Federated Identity values for Privilege</h2>
        <p className="card__note">Create a Federated Identity with these four values, grant it scope <code>mcp</code> on the door, and the gateway can verify the tokens below.</p>
        <dl className="kv">
          <Row k="Issuer" testId="v-issuer"><Mono>{c.issuer}</Mono>{!c.publicUrlSet && <span className="chip chip--warn">placeholder: set PUBLIC_URL</span>}</Row>
          <Row k="Audience" testId="v-audience"><Mono>{audience || c.audience}</Mono></Row>
          <Row k="Subject" testId="v-subject"><Mono>{c.validSub}</Mono></Row>
          <Row k="JwksURI" testId="v-jwks"><Mono>{c.jwksUrl}</Mono></Row>
          <Row k="MaxTokenLifetimeSec">at least <Mono>{String(c.ttlSeconds)}</Mono></Row>
        </dl>
      </div>
      <div className="card card--neutral" data-testid="lab-settings">
        <h2 className="card__title">Settings this lab is using</h2>
        <dl className="kv">
          <Row k="Trust domain"><Mono>{c.trustDomain}</Mono></Row>
          <Row k="Signing algorithm"><Mono>{c.alg}</Mono></Row>
          <Row k="Token lifetime"><Mono>{`${c.ttlSeconds}s`}</Mono>{c.ttlClamped && <span className="chip chip--warn">capped at 300s</span>}</Row>
          <Row k="Untrusted token">{c.untrustedMode === "issuer" ? "different issuer, unpublished key" : "right claims, unpublished key"}</Row>
          <Row k="Published key id"><Mono>{c.trustedKid}</Mono></Row>
          <Row k="Gateway">{c.gatewayOrigin ? <Mono>{c.gatewayOrigin}</Mono> : <span className="chip chip--warn">not set (SPIFFE_GW_URL)</span>}</Row>
          <Row k="Door app">
            {c.apps.length > 1
              ? (<select aria-label="Door app" value={app || ""} onChange={(e) => onApp(e.target.value)} data-testid="app-select">{c.apps.map((a) => <option key={a} value={a}>{a}</option>)}</select>)
              : c.apps.length ? <Mono>{c.apps[0]}</Mono> : <span className="chip chip--warn">not set (SPIFFE_GW_APPS)</span>}
          </Row>
        </dl>
        {c.problems.length > 0 && <p className="field-error" role="alert">{c.problems.join("; ")}</p>}
      </div>
    </section>
  );
}
