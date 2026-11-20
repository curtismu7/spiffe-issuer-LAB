# Changelog

## Unreleased
- SPIRE card: a Docker / Cluster (K8) switch (`GET/POST /api/spire/target`). Test follows the choice; Cluster tests `SPIRE_SERVER_URL` and shows placeholder `kubectl` commands instead of Start/Restart (the lab holds no cluster credentials); Docker keeps working while a cluster URL is set. Cluster refuses with 409 until `SPIRE_SERVER_URL` is valid. The "Set up on your side" guide only borrows your URL on Cluster.
- SPIRE server control card (Settings page): test, start and restart a throwaway local SPIRE in Docker, or test a SPIRE you run yourself (`SPIRE_SERVER_URL`, optional `SPIRE_AGENT_URL`, `SPIRE_ALLOWED_HOSTS`), plus a collapsible "Set up SPIRE on your side" guide (five steps, filled in with the lab's trust domain, namespace and agent names, placeholders for everything else).
- Fixed while finishing it: the generated SPIRE config crashed the server on start (`ca_subject` needs lists), leaving a restart loop that the old check reported as "running"; the local check now needs the server's own `/ready` to answer 200, and a start waits (bounded) for it. A path prefix in `SPIRE_SERVER_URL` is accepted (a shared ingress serves SPIRE under one). An invalid URL is reported, not silently replaced by the local mode. If the discovery document's `jwks_uri` points at the wrong place, the test falls back to `<base>/keys` and says which URL to use. A key set that publishes private key material fails the test. The optional agent probe no longer fails an otherwise good remote test.
- `scripts/verify-svid.mjs`: verify a JWT-SVID's signature against a published key set from the outside, with no cluster access. Token from the environment or stdin, never printed.
- Docs: README and CLAUDE.md now record that a real SPIRE's JWT-SVID was accepted by a real Privilege gateway (2026-11-19); the lab's own tokens still have no recorded real run.

## 0.1.0 (2026-11-19)

First release.

- Generates two signing keys at first start (published and never-published), persisted in the data directory with mode 600.
- Publishes `/.well-known/jwks.json` and `/.well-known/openid-configuration` for a configurable `PUBLIC_URL` (the issuer).
- Mints three JWT-SVIDs (valid, mismatched, untrusted) for a configurable trust domain and workload, lifetime capped at 300 seconds, RS256 or ES256.
- Page with the settings, the Federated Identity values for Privilege, the decoded tokens (shared JsonPane), copy buttons, and a "Present to the gateway" action: initialize + tools/list per token, a 3-row result table, and the shared "What Privilege did" trace.
- Mock rehearsal (in-process, labelled MOCK) and Real (one configured gateway origin through the shared real-hop client).
- `npm run doctor`, `scripts/verify-live.mjs`, Docker (loopback publish, read-only, key volume), CI on Node 26.
