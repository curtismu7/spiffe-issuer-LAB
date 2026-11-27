# User tenant provisioning for the SPIFFE lab spec

**Status:** draft   **Owner:** curtismu7

## Goal
When a user hands us API credentials for their PingOne Privilege tenant, a script in this lab repo provisions everything the lab's Real mode needs on their tenant (federated identity, agent key, door, grant), writes the lab `.env`, verifies 200/401/401 live, and prints what (if anything) they must do by hand in the console.

## Inputs (env only, never argv, never printed, never written to disk)
- `PRIV_TENANT` — tenant id
- `PRIV_API_KEY` + `PRIV_API_SECRET` — console API key/secret (or the scheme the console host actually accepts; see privilege-console-api skill — scheme differs per host)
- `CONSOLE_API` — console base URL (default the known console host)
- Optional: `LAB_DOOR_NAME` (default `lab-agg-limited`), `LAB_DRY_RUN=1`

## Acceptance criteria (each a runnable check)
1. Given valid creds, `--check` exits 0 and prints the tenant id and counts of existing apps/keys/identities (no secrets echoed).
2. Given valid creds, a full run creates (in order): federated identity `spiffe-issuer-lab-svid` (issuer `https://curtismu7.github.io`, JWKS `https://curtismu7.github.io/.well-known/jwks.json`, subject `spiffe://lab.example/ns/agents/sa/mcp-agent`, max lifetime 300, scope mcp), agent key `lab-spiffe-issuer-key` (custodian = that identity), grant `lab-spiffe-issuer-key-grant` (issued to the identity, on the door, limited tool set). Door `lab-agg-limited` is created only if no suitable MCP door exists; an existing compatible door is reused and the run says so.
3. Re-running the full script is idempotent: existing objects are detected by name and skipped, exit 0, no duplicates, no 409 escalation (delete-first only with an explicit `--replace <name>` flag).
4. On success the script writes the lab `.env` (`SPIFFE_GW_URL`, `SPIFFE_GW_APPS`, `SPIFFE_AUDIENCE=priv-nhi-…`) with a timestamped backup of any prior `.env`, and prints the four values with the audience value masked except its first 12 chars.
5. After the ~4-minute propagation wait (skippable with `--skip-wait`), the script runs the lab's real check against the door and prints the three outcomes; success requires Valid 200 AND Mismatched 401 AND Untrusted 401.
6. Every create is preceded by a backup of the object it modifies or replaces, saved to `~/.config/demo-kit/backups/provision-<ts>/` (mode 600); at the end the script runs an orphan check over the objects it created and prints `orphan 0` or the orphans found.
7. `LAB_DRY_RUN=1` prints every action it would take, touches nothing, exit 0.
8. Gateway enrolment check: the script detects whether the tenant has an enrolled AI Gateway node; if not, it stops after printing exact console enrolment instructions (numbered, copy-pasteable) and exits with a distinct code (2).

## Unhappy paths (each needs a check too)
- Bad/expired creds → clear message naming which auth failed at which host, exit 1, fail-closed (no partial writes: create order is identity → key → grant, and a failure mid-run prints what was created and what was not).
- Name collision with a pre-existing non-lab object → stop, print the colliding name and the `--replace` guidance, exit 1; never rename or delete objects the script did not create.
- Door's MCP backend tool names differ from the grant's expected member-aliased names (`banking-mcp__…` trap) → the verification step surfaces the mismatch as "grant tool names do not match the door's tools/list" with both lists printed.
- Propagation window (policy not yet at gateway) → verification retries up to 3 times at 60 s intervals before declaring failure.
- Identity already exists with a different custodian/subject → detected in the idempotency scan, reported as a conflict, exit 1 (not silently reused).
- No gateway node → exit 2 with enrolment instructions (criterion 8).

## Out of scope
- Enrolling a gateway node (manual; instructions printed).
- Wiring the door's MCP backend servers, or anything about their MCP servers' tool sets.
- MFA/sign-on policy changes on the tenant.
- Creating credentials; the script consumes them, never generates or stores them.
- Mock-mode setup (needs nothing, already works).

## Protected / must not break
- The lab's existing `.env` contract (`SPIFFE_GW_URL`, `SPIFFE_GW_APPS`, `SPIFFE_AUDIENCE` — a non-URL, non-`priv-nhi-…` audience must stop the lab from starting, unchanged).
- The user's tenant: no writes outside the four `lab-*` objects; backups before every write; `--dry-run` default-off but always available.
- No secret values in logs, output, backups of new objects, or committed files.

## Verification plan
- Unit tests for the idempotency scan, collision handling, and backup naming (mock API layer, no network).
- Dry-run against the owner's own tenant (`5bfb4e12`) with `LAB_DRY_RUN=1`: shows the exact actions, orphans none.
- Full live run only on the owner's explicit go, against a tenant the owner names; verify 200/401/401; owner approves before the PR merges.
- Owner reviews any doc that names their tenant infrastructure before merge (video handoff rule).
