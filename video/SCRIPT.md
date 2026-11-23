# Script: an agent proves who it is with a short-lived signed token (SPIFFE Issuer LAB, lab only)

Written first, before any recording (video standard: every video has a script, built from the specs and docs actually read, not from memory). `captions.md` carries the on-screen wording and must say what this script says. If a source changes, change the script, then the captions, then retake. **Status: DRAFT 3, 2026-11-22. Every fact below was read once, then re-fetched by two independent readers who tried to refute it; their corrections are folded in (see "Corrections from the independent read"). Rows marked VERIFY are not yet safe to put on screen. The multi-lens review (truth against the live system, spec accuracy, audience, code, sensitive data) was done by a separate reviewer and its findings are folded in (see "Review outcomes"). The sample has not yet been shown to the owner.**

- **Format:** silent screen capture with numbered captions and full-screen slides, light theme, about 3 minutes. **No slide is held longer than 10 seconds** (owner standard, 2026-11-22), so slide text is about 40 words (the reading standard is about 4 words a second). Two cuts, one per screen (owner, 2026-11-22): `PROFILE=monitor` (1920x1080) and `PROFILE=laptop` (retina laptop display). Opens and closes with a slide. **Real mode only for the real take**; the sample is the mock and says so.
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

1. The mode badge says Real and `GET /api/info` reports `source: real`; the take refuses to run otherwise. A 200 on Present is the proof the gateway origin is the working one.
2. The public key list URL is https, fetched with certificate checking, returns 200, holds exactly one RSA key (`n`, `e`), has no private field, and its `kid` equals the lab's `trustedKid`; the lab's `alg` is RS256 and its untrusted mode is `key`.
3. Present answers Valid 200 and Mismatched and Untrusted 401 on a dry run (rehearsal); the take re-checks the rows and aborts if not, and the captions read the live statuses.
4. The three tokens differ as described, checked on the decoded tokens on screen: Mismatched differs from Valid only in `sub`; Untrusted differs only in its `kid` (which is not in the key list); `exp - iat` equals the lifetime; the Valid `sub`, `aud`, `iss` equal the configuration.
5. The values on the "How Privilege is set up" slide are read from the console API by the take itself (14 read-only comparisons with the live lab, needs `PRIV_TENANT` and `CONSOLE_API` in the environment), and the slide is stamped with that day's date. The identity's `NotAfter` is 2026-12-31.
6. The take asserts the SPIRE card is hidden and that the first trace exchange is the Valid token's. By hand: the Docker context is OrbStack, the screen is unlocked or `HEADLESS_REAL=1` is used.

## Scenes

Slides are full screen and unnumbered; caption bubbles are numbered. Exact words live in `captions.md`.

| # | On screen | What the viewer reads (gist) | Source |
|---|---|---|---|
| Open | Slide | The obvious way to let an agent in is a stored credential: whoever holds it is the agent, and it works until revoked. The alternative: a short-lived signed token for one audience, checked against a public key list. This lab only mints test tokens; it is not SPIRE. | SVID §3.2, §3.3, §7.1; PRIV intro; LAB |
| 1 | Lab page, mode badge and banner | Real mode: the tokens go to one real gateway door (an MCP endpoint guarding a set of tools). The lab stands in for the agent: it signed the tokens itself; not SPIRE, no workload attested. | LAB |
| 2 | Card 1, "Federated Identity values" | What the gateway is told to trust: who issues the token (iss), where to fetch the public key list, who the token is for (aud, the door), and the one SPIFFE ID (the workload's name as a URI). | PRIV; SVID §3.1, §3.2 |
| 3 | New tab: the key list URL | One public key: `kty`, `n`, `e`, `kid`, `use`, `alg`. No `d`: the private half never leaves the lab. | JWKS (RFC 7517 §5, §4.5, §7; RFC 7518 §6.3.1, §6.3.2) |
| 4 | Back on the page, fresh tokens minted, Valid card decoded | The token's three required claims (sub, aud, exp) plus iss and iat; `exp` two minutes after `iat` (read from the decoded token); aud is the door URL. | SVID §3.1-§3.3; JWT §4.1 |
| 5 | Mismatched card | Same key, same everything, but a different SPIFFE ID in `sub`. | LAB |
| 6 | Untrusted card | The right SPIFFE ID, signed with a second key that was never published (a different `kid`). | LAB; JWKS |
| Slide | "How Privilege is set up" (after the three tokens) | The same values as read from Privilege on the day of the take: the identity, the key whose custodian is the identity, the grant on one door. Closes: a signed token, not a stored credential. | CONSOLE; PRIV |
| 7 | Press "Present to the gateway" | Present mints fresh tokens with the same claims and sends each as `Authorization: Bearer` on an MCP request: initialize, then tools/list. | BEARER §2.1; MCP; SVID §5.2 |
| 8 | Results: Valid | 200, and the gateway's tool list came back (4 tools). | LIVE |
| 9 | Results table | 401 for both, each in the gateway's own words (the take quotes each one; the Mismatched answer may read differently from Untrusted). The gateway names no reason for either; each token differs from Valid in the subject, or the key. MCP says an invalid token MUST get 401. | LIVE; MCP |
| 10 | Request trace, the Valid exchange (the others folded) | The request as sent: the bearer header (the token is kept on the server, not shown) and the JSON-RPC call; the response. | LIVE; BEARER §2.1 |
| Close | Slide | What the run showed: one right token let in, two wrong ones refused, a two-minute token for one door. Limit: this lab minted the tokens and attests no workload. | all |

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

## Review outcomes (2026-11-22, separate reviewer, then re-checked)

What the multi-lens review found and what was done:

- **Overclaims fixed:** "the cause is the one difference" became "the gateway gives no reason; the only difference is ..."; "so no one can check it" and "private half never leaves the lab" were cut or narrowed; "applies the same checks" (the mock) became "answers by its own rules"; "in production SPIRE issues them" was removed (no source in the SPIFFE pages), the closing slide now says the lab attests no workload; "aud is scoped" became "should be scoped".
- **Shown tokens vs sent tokens:** Present mints fresh tokens, so the take now mints right before the token scenes (so the decoded `iat`/`exp` are well inside two minutes) and the Present caption says "fresh tokens with these same claims".
- **Take checks added:** the decoded tokens are compared on screen (the claims differ exactly as captioned); both refused rows must read the same; a missing tool count, a missing or non-Valid first trace exchange, a wrong bubble count, a visible SPIRE card or a missing recording now fail the take and set a non-zero exit code; the public key list is fetched with certificate checking.
- **Public repo:** no default console host in the code; the console API origin comes from `CONSOLE_API`. The repo's host test allows the two public docs hosts used in this file.
- **Audience:** SPIFFE ID, door and MCP are glossed before the setup slide, which moved after the three tokens; the lab is named as standing in for the agent.
- **Left for the owner:** the sample's setup slide says the values were read "on an earlier day".
