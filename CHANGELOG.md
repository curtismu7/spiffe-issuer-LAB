# Changelog

## 0.1.0 (2026-11-19)

First release.

- Generates two signing keys at first start (published and never-published), persisted in the data directory with mode 600.
- Publishes `/.well-known/jwks.json` and `/.well-known/openid-configuration` for a configurable `PUBLIC_URL` (the issuer).
- Mints three JWT-SVIDs (valid, mismatched, untrusted) for a configurable trust domain and workload, lifetime capped at 300 seconds, RS256 or ES256.
- Page with the settings, the Federated Identity values for Privilege, the decoded tokens (shared JsonPane), copy buttons, and a "Present to the gateway" action: initialize + tools/list per token, a 3-row result table, and the shared "What Privilege did" trace.
- Mock rehearsal (in-process, labelled MOCK) and Real (one configured gateway origin through the shared real-hop client).
- `npm run doctor`, `scripts/verify-live.mjs`, Docker (loopback publish, read-only, key volume), CI on Node 26.
