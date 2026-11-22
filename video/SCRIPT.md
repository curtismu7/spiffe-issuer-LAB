# Script: an agent proves who it is with a short-lived signed token (SPIFFE Issuer LAB, lab only)

Written first, before any recording (video standard: every video has a script, built from the specs and docs actually read, not from memory). `captions.md` carries the on-screen wording and must say what this script says. If a source changes, change the script, then the captions, then retake. **Status: DRAFT 2, 2026-11-22. Every fact below was read once, then re-fetched by two independent readers who tried to refute it; their corrections are folded in (see "Corrections from the independent read"). Rows marked VERIFY are not yet safe to put on screen. The multi-lens review (truth against the live system, audience, sensitive data) is still to do before the sample.**

- **Format:** silent screen capture with numbered captions and full-screen slides, light theme, about 4 minutes. **No slide is held longer than 10 seconds** (owner standard, 2026-11-22), so slide text is a skim of at most about 75 words. Opens and closes with a slide. **Real mode only for the real take**; the sample is the mock and says so.
- **Audience:** a colleague who knows what an AI agent and an API key are, but has not seen SPIFFE or a Privilege Federated Identity. Internal viewers only for now (owner, 2026-11-22): the gateway host and the JWKS host stay visible on screen.
- **One idea:** an agent does not need a stored secret. It presents a short-lived signed token; the gateway checks the signature against a public key list it fetches, so the right token is accepted and a token with the wrong identity or an unpublished key is refused.
- **Scope (owner, 2026-11-22):** lab only. No PingFederate segment, no shared-SPIRE button, no console screens.

## Sources (read for this script, 2026-11-22)

| Tag | Source | What the script takes from it |
|---|---|---|
| **SVID** | SPIFFE, JWT-SVID, <https://github.com/spiffe/spiffe/blob/main/standards/JWT-SVID.md> (page shows "Stability: Stable", no version or date) | §3.1 `sub` MUST be the workload's SPIFFE ID; §3.2 `aud` MUST be present and a validator MUST reject a token whose audience it does not match, values SHOULD be scoped to the receiving service, one value "strongly recommended" "in normal cases"; §3.3 `exp` MUST be set, keep validity small; §2.2/§2.3 `kid` and `typ` optional; §2.1 `alg` MUST be a listed value (RS256 is in the table); §5.2 "transmitted via HTTP SHOULD be transmitted in the Authorization header" (Bearer, citing RFC 6750 §2.1); §6 / §6.1 signing keys are published as RFC 7517 JWK entries, `kid` and `use: jwt-svid` MUST be set on each; §7.1 bearer tokens can be replayed, so an aggressive `exp` is recommended; §7.3 channels "should" be confidential. **iss and iat are not required by this spec** |
| **SPIFFE-ID** | SPIFFE ID, <https://github.com/spiffe/spiffe/blob/main/standards/SPIFFE-ID.md> | §2 `spiffe://<trust-domain>/<path>` with scheme `spiffe` MUST and an optional path; trust-domain and path character rules; the path's meaning is left to the implementer |
| **WORKLOAD** | SPIFFE Workload API, <https://github.com/spiffe/spiffe/blob/main/standards/SPIFFE_Workload_API.md> | §6.2.1 a workload asks for short-lived JWT-SVIDs for a specific audience; §6.2.2 bundles are "a standard JWK Set" of the JWT-SVID signing keys; §6.3 a validator uses the trust-domain bundle and a token with no bundle is untrusted. **None of the three SPIFFE pages names SPIRE or describes attestation** |
| **JWT** | RFC 7519, <https://www.rfc-editor.org/rfc/rfc7519> (May 2015, updated by RFC 7797 and 8725) | §4.1.1 iss, §4.1.2 sub, §4.1.3 aud (when the claim is present and the recipient is not in it, the token MUST be rejected), §4.1.4 exp (MUST NOT be accepted on or after it), §4.1.6 iat; all optional in general; §8 implementations are RECOMMENDED to also support RS256 (only HS256 and `none` MUST be implemented) |
| **JWKS** | RFC 7517, <https://www.rfc-editor.org/rfc/rfc7517>; RFC 7518 §6.3.1 and §6.3.2 | RFC 7517 §5 a JWK Set is a JSON object with a `keys` array; §4.5 `kid` is used to match a specific key (optional in RFC 7517; the JWT-SVID spec tightens it); RFC 7518 §6.3.1 `n` and `e` are the RSA public parameters and §6.3.2 `d`, p, q, dp, dq, qi (and `oth`) are the RSA private-key parameters; RFC 7517 §7: access to non-public key material by parties without legitimate access MUST be prevented |
| **BEARER** | RFC 6750, <https://www.rfc-editor.org/rfc/rfc6750> (updated by RFC 8996 and 9700) | §2.1 `Authorization: Bearer <token>` (clients SHOULD use this header; resource servers MUST support it); §5.3 clients MUST use TLS with bearer tokens, token servers SHOULD issue short-lived (one hour or less) tokens and SHOULD issue them with an audience restriction. It does not define a JWT |
| **HTTP** | RFC 9110, <https://www.rfc-editor.org/rfc/rfc9110> | §15.5.2 a 401 MUST carry `WWW-Authenticate` with a challenge (also §11.6.1); "If the request included authentication credentials, then the 401 response indicates that authorization has been refused for those credentials"; §11.4 a request that omits, or has invalid, credentials SHOULD get 401, with no distinction in status |
| **MCP** | Model Context Protocol, Authorization, <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization> (the newest revision the site links; the 2025-06-18 revision says the same on these points) | "Access Token Usage" > "Token Requirements": authorization MUST be included in every HTTP request; "Token Handling": invalid or expired tokens MUST receive a 401, and MCP servers MUST validate that tokens were issued specifically for them as the audience. The page is silent on a JSON body for a 401 (the claim "no body specified" is an absence, not a statement on the page). The 2026-07-28 revision is the only one the spec index links (not labelled "latest") Which revision Privilege implements is not documented: VERIFY before naming a version on screen |
| **PRIV** | Ping docs, "Registering federated identities" (revised 2026-10-21) and "Agent registry" (revised 2026-09-10), <https://docs.pingidentity.com/privilege/agent-privilege/configuration/federated-identities.md> and `.../agent-registry.md` | Intro sentence: Federated Identities are workloads that authenticate with a signed token issued by a trusted platform, workload identity system or host-held signing key instead of a stored credential; fields Issuer (iss), Subject (sub), JWKS URL ("Fetch from URL"), Max token lifetime (default 3600 s), Required claims ("checked after the signature"); the Audience is an **output** of registration ("generates an Audience for it"), not an input; SPIFFE JWT-SVIDs are a listed workload-identity option; key custodian can be a Federated Identity ("acts as this identity and inherits its policy"); the Agent registry page says credentials and tokens "terminate at the AI Gateway" (the AI gateways page says only that the gateway injects backend credentials so agents never hold them). **Not documented:** a status code for a rejected workload token (the only 401 on these pages is for an unauthenticated call to the gateway's well-known document); that the gateway checks `aud`; a full verification sequence (only "signature, then required claims"). The live run supplies the statuses |
| **CONSOLE** | The Privilege console objects, read-only through the console API, 2026-11-22 (nothing changed in the read) | The identity, key and grant this lab was wired to on 2026-11-22 (the "How Privilege is set up" slide). Re-read before the take |
| **PRIV-OBS** | Our own earlier verified tests (`privilege-nhi-setup` skill, 2026-10-26 and this session) | The identity's Issuer is matched exactly against `iss`; the required `sub` claim pins one SPIFFE ID; a grant needs the identity set on it. Our observation, **not Ping documentation**: say "we configured" not "Ping says" |
| **LAB** | This repo's README, CLAUDE.md and code | The lab mints three test tokens, publishes the key list, presents each to a real MCP door; it is a token minter, not SPIRE; lifetime default 120 s, capped at 300 s; Mock rows say MOCK |
| **LIVE** | The wiring and re-runs of 2026-11-22 | Valid 200 with a tool list (4 tools), Mismatched 401 "Unauthorized", Untrusted 401 "Unauthorized", three runs in a row. The gateway logs no per-call accepted or rejected line for these tokens, so the reason for each 401 is inferred from the one thing that differs from Valid |

**Wire-format note, said once on the opening slide:** the SPIFFE page defines the token; the door speaks MCP over HTTP. Nothing in the video names a spec revision the product has not been shown to follow.

**Checks before recording (a script is only true if the run is):**

1. The mode badge says Real and `GET /api/info` reports `source: real` with the configured gateway origin (the owner's working gateway, not the old one); the take refuses to run otherwise.
2. The public key list URL returns 200 over https, holds exactly one key, has no `d` and its `kid` equals the lab's `trustedKid`.
3. Present answers Valid 200 and Mismatched and Untrusted 401 on a dry run (rehearsal); the take re-checks the rows and aborts if not, and the captions read the live statuses.
4. The three tokens differ as described: Mismatched differs from Valid only in `sub`; Untrusted differs only in its `kid`/signing key (re-read the decoded tokens).
5. The values on the "How Privilege is set up" slide were read from the console API the same day (identity enabled, not expired: its `NotAfter` is 2026-12-31).
6. The SPIRE card is hidden for the take, and the Docker context is OrbStack.

## Scenes

Slides are full screen and unnumbered; caption bubbles are numbered. Exact words live in `captions.md`.

| # | On screen | What the viewer reads (gist) | Source |
|---|---|---|---|
| Open | Slide | The obvious way to let an agent in is a stored secret: whoever holds it is the agent, and it keeps working. The alternative here: a short-lived signed token the gateway checks against a public key. This lab only mints test tokens; it is not SPIRE, so it attests no workload. | SVID §7.1; PRIV intro; LAB |
| 1 | Lab page, mode badge and banner | Real mode: the tokens go to one real gateway; test tokens this lab signed itself. | LAB |
| 2 | Card 1, "Federated Identity values" | What the gateway is told to trust: who issues the token (iss), where to fetch the public key list, who the token is for (aud, the door), and the one SPIFFE ID. | PRIV; SVID §3.1, §3.2 |
| Slide | "How Privilege is set up" | The same values as read from Privilege on 2026-11-22: the identity, the key whose custodian is the identity, the grant on one door. No stored secret on the agent. | CONSOLE; PRIV |
| 3 | New tab: the key list URL | One public key: `kty`, `n`, `e`, `kid`, `use`, `alg`. No `d`: the private half never leaves the lab. | JWKS (RFC 7517 §5, §4.5, §7; RFC 7518 §6.3.1, §6.3.2) |
| 4 | Back on the page, Valid card decoded | The token's three required claims (sub, aud, exp) plus iss and iat; `exp` two minutes after `iat`; aud is the door URL. | SVID §3.1-§3.3; JWT §4.1 |
| 5 | Mismatched card | Same key, same everything, but a different SPIFFE ID in `sub`. | LAB |
| 6 | Untrusted card | The right SPIFFE ID, signed with a second key that was never published (a different `kid`). | LAB; JWKS |
| 7 | Press "Present to the gateway" | Each token is sent as `Authorization: Bearer` to the door; initialize, then tools/list. | BEARER §2.1; MCP; SVID §5.2 |
| 8 | Results: Valid | 200, and the gateway's tool list came back (4 tools). | LIVE |
| 9 | Results: Mismatched, Untrusted | 401 for both, in the gateway's own words ("Unauthorized"). The reason is inferred from the one difference; the gateway names none. MCP says an invalid token MUST get 401; RFC 9110 says a 401 to a request with credentials means authorization was refused for those credentials. | LIVE; MCP; HTTP |
| 10 | Request trace pop-out (Valid or Untrusted) | The request as sent: the bearer header (the token is kept on the server, not shown) and the JSON-RPC call; the response. | LIVE; BEARER §2.1 |
| Close | Slide | What the run showed: one right token let in, two wrong ones refused, nothing stored on the agent, token gone in two minutes. Limits: the lab, not SPIRE, minted the tokens; production SPIRE attests the workload. | all |

## What is deliberately not in the video

- Anything claiming the lab attests a workload or is SPIRE. Say "this mints SVIDs; SPIRE attests the workload" if asked.
- The SPIRE control card, the shared-cluster "Get a demo SVID" button, the PingFederate exchange and the AI-DEMO2 `/spiffe-privilege` page (owner: lab only).
- The 2026-11-19 real-SPIRE run: its evidence is HTTP statuses only and it is not this lab's tokens.
- Wrong audience, expired and tampered-signature cases: not run live for this lab. Do not say the gateway checks audience (no Ping page says so).
- A gateway log line for these tokens (none exists), and any named reason for a 401 beyond "the one difference".
- A named MCP spec revision for the product, and the word "verified" about anything other than the live statuses.

## What is on screen that needs a decision

- **Visible, on purpose, internal only:** the gateway host (an internal SE-cluster name; not written in this public repo), the key-list host (a public GitHub Pages site), the SPIFFE ID `spiffe://lab.example/...`, the door name. Decide before sharing the video outside the company.
- **Hidden in the take:** the SPIRE card (CSS), and the raw token and signature text in the three cards (blurred; the decoded header and payload stay readable). The tokens are test tokens that expire in 120 seconds, and the private keys are never on screen.
- **Not in the repo:** recordings and contact sheets (`video/out/`) and the console read-out are local only.

## Corrections from the independent read (2026-11-22)

Two fresh readers re-fetched every source and tried to refute each claim. What changed, and what the video must not say:

- **RS256:** RFC 7519 §8 says implementations are RECOMMENDED to support RS256; it does not say to use it. The video never calls RS256 recommended.
- **RSA key parts:** the private parameters are RFC 7518 §6.3.2 (not §7.5.1, which is only a registry listing).
- **JWK Set wording:** "JWK Set" is the Workload API's wording (§6.2.2); JWT-SVID §6 says "JWK entries". The slide says "key list (JWKS)".
- **`kid`:** optional in RFC 7517 and in a JWT-SVID header; required on every bundle key by JWT-SVID §6.1. The lab sets it on both.
- **Audience at Privilege:** an output of registration, not a field the admin types; our identity's audience is the door URL (set through the API on a generic OIDC identity). The video says "the identity's audience", never "Privilege generated".
- **Verification sequence:** Ping documents "signature, then required claims", no more.
- **MCP versions:** the 2025-06-18 text adds "even if they are part of the same logical session" and a typo-like subject in one sentence; the three points used here are the same in both.
- **iss and iat:** the JWT-SVID spec requires neither; the lab's tokens carry both, so the video says the spec's three required claims are sub, aud and exp.
- **Left as "inferred", not sourced:** that Privilege matches the issuer exactly (PRIV-OBS, our own test), and which MCP revision Privilege follows.
- **Gaps to keep out of the video:** a Privilege status code for a bad workload token; any claim the gateway validates `aud`; SPIRE or attestation (the SPIFFE pages do not mention either).
