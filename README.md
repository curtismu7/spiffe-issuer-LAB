# SPIFFE Issuer LAB

Mints three short-lived test JWT-SVIDs (valid, mismatched, untrusted), publishes the JWKS and OIDC discovery a PingOne Privilege gateway can fetch, and presents each token to an MCP door. **A token minter, not SPIRE:** nothing here attests a workload.

Tier: Tool
Repo: https://github.com/curtismu7/spiffe-issuer-LAB
Catalog: none (no catalog row matches this lab; it supplies the issuer half of Ping's MCP test #30, "present a valid and a mismatched or untrusted SPIFFE identity to the gateway"). Setup guide for the Privilege side: https://curtismu7.github.io/nyl-demo-starter/guides/30-spiffe.html

## What is simulated

Real by design, not simulated: the signing keys (generated at first start), the JWT-SVIDs (real signatures), the JWKS and discovery documents (served over HTTP, verifiable by any client), and, in Real mode, the call to your gateway.

Simulated or not claimed:

- **Not SPIRE.** The lab signs whatever SPIFFE ID it is configured with. No workload is attested, no trust bundle is rotated.
- **Mock mode** (the default with no settings) rehearses against an in-process stand-in that applies the same checks to the published JWKS. Every Mock row says MOCK; it is never a Privilege result, and its error words are the lab's own.
- **Verified once, by a real SPIRE and not by this lab:** on 2026-11-19 a JWT-SVID issued by a real SPIRE server (1.7.2 on Kubernetes) was presented as the bearer to a real Privilege gateway door. The registered SPIFFE ID got 200 with a tool list; another ID, a wrong audience, a tampered signature and no token each got 401. The Federated Identity was set to fetch SPIRE's keys by URL. So a gateway does accept a SPIFFE JWT-SVID presented directly.
- **Still UNVERIFIED:** this lab's OWN tokens (RS256, `aud` as one string) have not been presented to a real gateway in a recorded run. `SPIFFE_AUD_ARRAY` and `SPIFFE_ALG=ES256` exist so the owner can match what SPIRE sends (an ES256 key, `aud` as an array) if the gateway answers otherwise.
- The three expected answers (200, 401, 401) are the lab's design. A row the gateway answers differently is shown as "not as designed", never hidden.

The three tokens:

| Token | iss | sub | aud | signed by |
|---|---|---|---|---|
| Valid | the issuer (`PUBLIC_URL`) | `spiffe://<trust-domain>/ns/<ns>/sa/<agent>` | the door URL | the published key |
| Mismatched | the issuer | a different SPIFFE ID in the same trust domain | the door URL | the published key |
| Untrusted | the issuer (or a different one, `SPIFFE_UNTRUSTED=issuer`) | the valid SPIFFE ID | the door URL | a second key that is never published |

Every token carries `kid`, `sub`, `aud`, `exp` and `iat`; `exp - iat` is at most 300 seconds.

## Run from a clone

Prerequisites: Node 26; Docker (OrbStack) only for the Docker form.

```sh
git clone https://github.com/curtismu7/spiffe-issuer-LAB.git
cd spiffe-issuer-LAB
./scripts/run.sh          # npm ci, build, doctor, start
```

Open http://127.0.0.1:7829/ . With no settings at all it works in Mock: three tokens, the settings page, and a rehearsal table (200, 401, 401). The signing keys are generated at first start in `.data/keys.json` (mode 600, gitignored, never shown or returned by any route).

Check a running lab from the outside, with `node:crypto` only (no lab code):

```sh
node scripts/verify-live.mjs [lab-url] [public-jwks-url]
```

## Settings file

Read from the lab's own `.env` beside `docker-compose.yml` (copy `.env.example`; gitignored, kept out of the image). From a clone, the `SPIFFE_*` keys may instead live in the shared settings file `~/Development/.env` (`STANDALONE_ENV` overrides the path); the environment wins over the file, and nothing else in the shared file is read. No secret is needed: the JWT-SVID is the credential.

Real needs all three of these:

- `PUBLIC_URL` - the public https origin where this lab's `/.well-known/` is reachable by the gateway. The issuer string in every token is exactly this origin.
- `SPIFFE_GW_URL` - the Privilege gateway origin (https; http only on loopback).
- `SPIFFE_GW_APPS` - comma-separated MCP door names. The door is `<SPIFFE_GW_URL>/<app>/mcp` and is also the token audience.

Optional:

- `SPIFFE_TRUST_DOMAIN` (default `lab.example`), `SPIFFE_NAMESPACE` (`agents`), `SPIFFE_AGENT` (`mcp-agent`, the Federated Identity's Subject), `SPIFFE_OTHER_AGENT` (`other-agent`).
- `SPIFFE_TTL_SECONDS` (default 120, capped at 300).
- `SPIFFE_ALG` (`RS256` default, or `ES256`; ES256 keys are built with `createECDH`).
- `SPIFFE_UNTRUSTED` (`key` default, or `issuer`), `SPIFFE_AUD_ARRAY` (`1` sends `aud` as an array), `SPIFFE_AUDIENCE` (override the audience).
- `DATA_DIR` (where `keys.json` lives; `/data` in Docker), `SHELF_URL`, `LAB_ALLOWED_HOSTS`.

## Ports, and what to do if the port is taken

Ports: spiffe-issuer listens on 7828 (set with PORT, default 7828; the lab accepts only its own port). The host publishes it on 7829 (HOST_PORT, the shelf's registry row).
Port range for this app: 7829-7829 (host publish; the container port stays 7828).

If the port is taken:
1. Find what is using it:
   lsof -iTCP:7829 -sTCP:LISTEN -n -P
2. If it is an old copy of this app, stop that process: kill <PID>.
3. If it is something else, stop it. (The Docker form can publish on another host port: HOST_PORT=<other port> docker compose up -d.)
4. Do not use 8080, 5173, 3000, 4000, 4400, 4510, 4600-4601, 18080, 19080 or 19090.

## Mock and Real modes

The header toggle switches at runtime (`POST /api/mode`, `GET /api/info` reports `source` and `realAvailable`).

- **Mock**: no outbound call. "Rehearse against the mock gateway" mints fresh tokens and checks them against the published JWKS in-process. Rows are labelled MOCK.
- **Real**: "Present to the gateway" mints fresh tokens and sends each as `Authorization: Bearer <jwt>` to the configured door, with `initialize` then `tools/list`, through the shared real-hop client. Only the one gateway origin is reachable (netguard), no redirects are followed, and the table shows the HTTP status and the gateway's own words per token. Real is the start mode whenever it is configured, so a rebuild never silently drops to Mock. Real not configured: the toggle's Real option is disabled and the page, and the server's 409, name exactly which settings are missing.

### Expose the JWKS (the owner's choice; the lab builds no deployment)

The gateway fetches `<PUBLIC_URL>/.well-known/jwks.json` over public https, so that URL must reach this lab. The lab binds loopback only; choose one:

- **A named tunnel** (Cloudflare named tunnel, ngrok with a reserved domain) pointing at `http://127.0.0.1:7828`. Use a stable name: a quick tunnel's address changes on every run, and the issuer is that address, so the Federated Identity would need editing each time.
- **The SE cluster or any host you control**: reverse-proxy the two public paths to the lab.

Whatever you pick, publish **only** `/.well-known/jwks.json` and `/.well-known/openid-configuration` (path-restrict the route if the tool allows). The lab helps: those two paths answer for any `Host`, and everything else answers only for loopback and `LAB_ALLOWED_HOSTS`; and `/api` refuses any request that carries a tunnel or proxy header (`x-forwarded-for`, `cf-connecting-ip`, `forwarded`, `x-real-ip`, `ngrok-*`). Do not rely on that alone: the API mints tokens your gateway trusts, so it must never be reachable from the internet.

Check it before touching Privilege: `curl https://<your-public-origin>/.well-known/jwks.json` shows one key with `n`, `e` (or `x`, `y`), `kid` and no `d`, and `node scripts/verify-live.mjs http://127.0.0.1:7828 https://<your-public-origin>/.well-known/jwks.json` exits 0.

### Wire the Privilege Federated Identity (Ping's MCP test #30)

In Privilege a Federated Identity is the console object `NonHumanIdentity` (`/v1/nonhumanidentities`). The page's first card shows the exact values; they are:

| Field | Value |
|---|---|
| Issuer | `PUBLIC_URL` |
| Audience | the door URL, `<SPIFFE_GW_URL>/<app>/mcp` |
| Subject | `spiffe://<trust-domain>/ns/<ns>/sa/<agent>` (leave "allow any subject" off) |
| JwksURI | `<PUBLIC_URL>/.well-known/jwks.json` |
| MaxTokenLifetimeSec | 300 (at least the lab's token lifetime) |
| Scopes | `mcp` only |
| Platform | `spiffe` (a UI hint; never used for verification) |

Then create an agent key whose custodian is the Federated Identity (leave the key's own workload identity and user reference empty) and select the MCP app: that is the grant. Allow about 4 minutes before the first call. In the gateway log, `upserted workload key <key> issuer=... subject=...` means the identity is wired; `rebuilding 0 key(s)` means no key sits behind it yet. A presented token logs `workload token accepted for key <k> issuer=... subject=...` or `workload token rejected: <reason>`. The reason is in the log, not the 401 body.

Put `PUBLIC_URL`, `SPIFFE_GW_URL` and `SPIFFE_GW_APPS` in `.env`, run `docker compose up -d`, check that `GET /api/info` reports `"source": "real"`, and click Present. Expected: Valid 200, Mismatched 401, Untrusted 401. If you change `PUBLIC_URL`, change Issuer and JwksURI in Privilege to match.

The console menu path is Directory, Federated Identities, Register Identity (checked 2026-11-19). SPIFFE-direct-to-gateway acceptance was verified with a real SPIRE (see the top of this file); the lab's own tokens have not yet had their recorded real run.

## Run, test or set up a real SPIRE (the SPIRE card on the Settings page)

The lab is a token minter, not SPIRE. The **SPIRE server control** card helps you see and test the real thing, and its **Set up SPIRE on your side** section is the step-by-step guide (five steps, filled in with your trust domain, namespace and agent names, and placeholders everywhere else).

- **Choose which one (Docker or Cluster).** The card has a Docker / Cluster (K8) switch, like the Mock/Real toggle: a runtime choice kept in memory. With `SPIRE_SERVER_URL` set the lab starts on Cluster, otherwise on Docker. Cluster is disabled (with the reason) until `SPIRE_SERVER_URL` is set; the API refuses it with 409. On Cluster the card tests your SPIRE and shows `kubectl` commands (placeholders only) for starting and restarting it: this lab holds no cluster credentials and never runs them. Docker still works while a cluster URL is set.
- **Docker demo SPIRE.** Start / Restart SPIRE runs a throwaway server on this machine in Docker (`spire-demo-server`, image `ghcr.io/spiffe/spire-server:1.7.2`, health on `127.0.0.1:18081`, loopback only). Test passes only when the container runs AND the server's own `/ready` answers 200. It needs Docker reachable from the lab, so from the Docker image it answers "Docker is not reachable" and starts nothing; run the lab from a clone to use it.
- **Cluster SPIRE (your own).** Put `SPIRE_SERVER_URL=https://<host>[/<prefix>]` in `.env` (optionally `SPIRE_AGENT_URL`, and `SPIRE_ALLOWED_HOSTS` for another origin that serves the keys). The card then tests THAT: discovery at `<base>/.well-known/openid-configuration` and the keys at the discovery `jwks_uri`, falling back to SPIRE's default `<base>/keys` (behind a path-rewriting ingress the discovery `jwks_uri` often points at the wrong place, and the card says so and tells you which URL to use). A pass means the keys are public, have a `kid`, and hold no private material; it cannot prove the server is SPIRE, so read the issuer and key algorithm it shows. A set but invalid URL is reported, never silently replaced by the Docker demo. Start and Restart do nothing on Cluster.
- **Network.** Testing your own SPIRE reaches only the origins you configured, only while you press Test, with no redirect followed (netguard). Mock mode otherwise makes no outbound call.

### Get a demo SVID from the shared cluster SPIRE (owner-provided)

Instead of running your own SPIRE, the owner can connect this lab to a shared cluster
SPIRE through a small token service. With it configured, the SPIRE card shows a
**"Get a demo SVID from the shared SPIRE"** button: it mints a real, short-lived
JWT-SVID (5 minutes) for this lab's identity, verifies it off-cluster exactly the way a
Privilege Federated Identity would — fetch the issuer's published keys, check the
signature, the lifetime, the expiry and the subject — and shows the decoded claims
(with the raw token folded away). It is the same check an MCP gateway runs on an
agent's token before opening the door.

To enable it, ask the owner for these three values (they are per person; the invite
key is a secret and never appears in the page, the logs or the repo), then put them in
the lab's `.env` and `docker compose up -d`:

| `.env` setting | What it is |
|---|---|
| `SPIRE_DEMO_TOKEN_URL` | The demo token service URL (ends in `/token`) |
| `SPIRE_DEMO_INVITE_KEY` | Your personal invite key (write-only: sent only server-to-service) |
| `SPIRE_DEMO_AUDIENCE` | The audience your tokens are minted for — the `priv-nhi-…` value of the Federated Identity on the Privilege side |

Where to see the values: the **"Federated Identity values for Privilege"** card (step 1
on the Settings page) always shows this lab's live configuration — the issuer
(`PUBLIC_URL`), the JwksURI, the subject (SPIFFE ID) and the audience of the door. When
the shared-SPIRE option is on, the SPIRE card's SVID section adds the one value the
shared setup uses instead of the door URL: the `priv-nhi-…` audience, shown as
**Minted for (audience)** under the claims of every minted SVID. For the shared setup
the owner pairs the Federated Identity's audience with your invite key; the lab itself
needs no Privilege access.

Without the three settings the section reads "not configured" and everything else works
as documented above. The Docker and Cluster checks do not depend on it.

### Verify a token from the outside (no cluster access)

Anyone can check that the published keys really verify a real token. The token comes from the environment or stdin, never an argument, and is never printed:

```
TOKEN=<jwt-svid> node scripts/verify-svid.mjs https://<host>[/<prefix>]/keys --iss <iss> --sub <spiffe-id> --aud <audience>
```

Exit 0: the signature verifies against the published key and every expectation holds. Exit 1: it does not (unknown key, bad signature, expired, a wrong iss/sub/aud). Exit 2: bad usage. This is the key-publishing half of the chain; the gateway's own decision is the 200/401 call in the last step of the in-page guide.

## Health, doctor and reset

- `GET /api/health` returns `demo-health/1` (public, GET only, no detail).
- `npm run doctor` prints one line per check and exits 1 on failure: Node, settings, bind, port, JWKS holds the public half only, the untrusted key is unpublished, the three tokens verify or fail as designed, the 300-second cap, netguard self-test, and (as information) whether Real is configured.
- Reset: this is a Tool-tier lab with no run state to clear; the page holds the last result in the browser. To rotate the signing keys, stop the lab and delete `.data/keys.json` (or the `spiffe-issuer-data` volume); the JWKS changes at the next start.

## Docker (optional)

```sh
docker compose up --build -d
```

Publishes `127.0.0.1:7828` only (never change that), runs read-only with no capabilities, restarts with Docker (`restart: unless-stopped`), and keeps the keys on the `spiffe-issuer-data` volume. Through the family lab-proxy the lab is at `https://local.ping-devops.com:8443/spiffe-issuer/`.

## Tests

```sh
npm test          # server (node --test), web (vitest), repo and compose checks
```

Node 26: server 30 pass, web 27 pass (8 of them the lab's own App tests, 19 the vendored gateway-trace tests), repo checks 11 pass. The tests verify the three tokens against the published JWKS with an independent `node:crypto` check, the 300-second cap, that no private key reaches any API response or log, the netguard (one origin, and only while presenting), and a Real present against a loopback stand-in for a door. A Real run against a Privilege gateway is the owner's; no test claims it.

## Troubleshooting

- **"Real is not configured. Missing: ..."**: set the named keys in `.env` and restart the lab (`docker compose up -d`).
- **The gateway answers 401 to the Valid token**: read the gateway log line `workload token rejected: <reason>`. Typical: Issuer differs from `PUBLIC_URL` (character for character), Audience is not the door URL, Subject differs, the gateway cannot fetch the JWKS (test the public URL from outside), or the identity has no agent key behind it yet. If the reason is about the algorithm or `aud` shape, try `SPIFFE_ALG=ES256` or `SPIFFE_AUD_ARRAY=1`.
- **The gateway cannot fetch the JWKS**: the tunnel must forward `Host` unchanged or any `Host`; the two `/.well-known/` paths answer for any Host. A path-restricted route must include both.
- **Tokens expire before I present them**: they last 120 seconds by default; "Present" always mints fresh ones. Raise `SPIFFE_TTL_SECONDS` (max 300) only if the identity's MaxTokenLifetimeSec allows it.
- **Port problems**: see "Ports, and what to do if the port is taken".

## Ownership

Owner: curtismu7. Licence: MIT (see `LICENSE`). Report problems as issues on https://github.com/curtismu7/spiffe-issuer-LAB .
