import React from "react";

const REPO = "https://github.com/curtismu7/spiffe-issuer-LAB";
const LINKS = [
  { label: "Live demo (lab-proxy)", href: "https://local.ping-devops.com:8443/spiffe-issuer/", note: "for colleagues on your network/VPN" },
  { label: "Launcher / demo shelf", href: "https://local.ping-devops.com:8443/" },
  { label: "GitHub repo", href: `${REPO}`, note: "public, works for anyone" },
  { label: "PF setup guide (Markdown)", href: `${REPO}/tree/main/docs/pf-setup-guide` },
  { label: "PF guide (PDF)", href: `${REPO}/blob/main/docs/pf-setup-guide/pingfederate-spire-setup-guide.pdf` },
];

// HelpCard: the links an owner shares with colleagues — the live demo, the
// shelf and the repo docs. Static, lab-owned, no fetches.
export default function HelpCard() {
  return (
    <div className="card card--neutral" data-testid="help-card">
      <h2 className="card__title">Links &amp; help</h2>
      <ul className="help-links">
        {LINKS.map((l) => (
          <li key={l.href}>
            <a href={l.href} target="_blank" rel="noreferrer">{l.label}</a>
            {l.note && <span className="help-links__note"> — {l.note}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
