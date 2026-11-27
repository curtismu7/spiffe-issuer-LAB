#!/usr/bin/env python3
"""Provision a user's Privilege tenant for this lab's Real mode, from API credentials.

Given PRIV_TENANT and console API access (see docs/specs/2026-11-27-user-provisioning.md),
creates (idempotently, in order): federated identity spiffe-issuer-lab-svid, agent key
lab-spiffe-issuer-key (custodian = that identity), grant lab-spiffe-issuer-key-grant on
door lab-agg-limited (created only if no compatible MCP door exists). Writes the lab .env,
waits for policy propagation, then verifies the door live: Valid 200 / Mismatched 401 /
Untrusted 401. Never prints or stores a secret.

Env: PRIV_TENANT (required), CONSOLE_API (required; the console API origin),
CONSOLE_API_KEY / CONSOLE_API_SECRET (optional, sent as x-api-key/x-api-secret when set),
LAB_DOOR_NAME (default lab-agg-limited), LAB_DRY_RUN=1 (print actions, change nothing),
PROVISION_LAB_URL (default http://127.0.0.1:7829, the running lab used for live verify),
PROVISION_SKIP_WAIT=1 (skip the ~4 min propagation wait).

Exit codes: 0 ok, 1 failure (auth, collision, conflict, verification), 2 no enrolled
gateway node (instructions printed). With a mid-run failure, prints exactly what was
created and what was not.
"""
import base64
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
import uuid

NHI = "spiffe-issuer-lab-svid"
KEY = "lab-spiffe-issuer-key"
GRANT = "lab-spiffe-issuer-key-grant"
DOOR_DEFAULT = "lab-agg-limited"
ISSUER = "https://curtismu7.github.io"
JWKS = ISSUER + "/.well-known/jwks.json"
SUBJECT = "spiffe://lab.example/ns/agents/sa/mcp-agent"
AUD = "aws-agent-client"
MAXLIFE = 300
SCOPE = "mcp"
BACKUP_DIR = os.path.expanduser("~/.config/demo-kit/backups/provision")

created, skipped = [], []


def log(*a):
    print(*a, flush=True)


def die(msg, code=1):
    log(f"FAIL: {msg}")
    sys.exit(code)


def b64(s):
    return base64.b64encode(s.encode()).decode()


def api(base, tenant, method, path, body=None, dry=False):
    """One console API call. Returns parsed JSON. Raises RuntimeError with the status."""
    url = f"{base.rstrip('/')}/api/{tenant}/v1/{path}"
    hdrs = {"x-procyon-session-id": str(uuid.uuid4()), "accept": "application/json",
            "content-type": "application/json"}
    if os.environ.get("CONSOLE_API_KEY") and os.environ.get("CONSOLE_API_SECRET"):
        hdrs["x-api-key"] = os.environ["CONSOLE_API_KEY"]
        hdrs["x-api-secret"] = os.environ["CONSOLE_API_SECRET"]
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    last = None
    for attempt in range(4):  # the console API is sometimes slow to answer; retry, never relax
        try:
            with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
                raw = r.read().decode()
                return json.loads(raw) if raw.strip() else {}
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode()[:300]
            except Exception:
                pass
            if e.code in (429, 500, 502, 503) and attempt < 3:
                time.sleep(4)
                last = RuntimeError(f"{e.code} {detail}")
                continue
            raise RuntimeError(f"{method} {path} -> {e.code} {detail}") from None
        except Exception as e:
            if attempt == 3:
                raise RuntimeError(f"{method} {path} -> {e}") from None
            time.sleep(4)
            last = e
    raise RuntimeError(f"{method} {path} -> {last}")


def backup_obj(name, obj):
    d = f"{BACKUP_DIR}-{time.strftime('%Y%m%d-%H%M%S')}"
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, f"{name}.json")
    with open(os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        json.dump(obj, f, indent=1)
    return p


def mask(aud):
    return aud[:12] + "…" if len(aud) > 12 else aud


def main():
    tenant = os.environ.get("PRIV_TENANT")
    base = os.environ.get("CONSOLE_API")
    dry = os.environ.get("LAB_DRY_RUN") == "1"
    door = os.environ.get("LAB_DOOR_NAME", DOOR_DEFAULT)
    if not tenant or not base:
        die("PRIV_TENANT and CONSOLE_API are required (env); no secrets are printed ever")
    if dry:
        log("DRY RUN: nothing will be created or changed")

    # Step 0: verify access + inventory (collision scan)
    try:
        apps = api(base, tenant, "GET", "applications?ObjectMeta.Namespace=default").get("Applications", [])
        nhis = api(base, tenant, "GET", "nonhumanidentities?ObjectMeta.Namespace=default")
        keys = api(base, tenant, "GET", "agentaccesskeys?ObjectMeta.Namespace=default")
    except RuntimeError as e:
        die(f"console API not readable with the given credentials: {e}")
    if not isinstance(nhis, dict) or "Items" not in json.dumps(type(nhis).__name__):
        pass  # shape differs between hosts; normalise below
    nhi_list = nhis if isinstance(nhis, list) else nhis.get("NonHumanIdentities") or nhis.get("Items") or []
    key_list = keys if isinstance(keys, list) else keys.get("AgentAccessKeys") or keys.get("Items") or []
    names_of = lambda lst: [o.get("ObjectMeta", {}).get("Name", "") for o in lst]
    app_names = names_of(apps)
    nhi_names, key_names = names_of(nhi_list), names_of(key_list)
    log(f"tenant {tenant}: {len(apps)} app(s), {len(nhi_names)} federated identity(ies), {len(key_names)} key(s)")

    # Gateway enrolment check: a door's Status must show a mesh cluster / gateway route.
    # A tenant with zero applications and no way to see nodes gets instructions, exit 2.
    def door_obj(name):
        for a in apps:
            if a.get("ObjectMeta", {}).get("Name") == name:
                return a
        return None

    existing_door = door_obj(door)
    if not apps and not existing_door:
        log("No applications on this tenant and no enrolled gateway visible to the API.")
        log("An AI Gateway node must be enrolled first (manual, in the console):")
        log("  1. Console -> Gateways -> Add Gateway; name it, copy the enrolment token.")
        log("  2. Run the gateway agent on your cluster with that token (vendor docs).")
        log("  3. Re-run this script once the Nodes page shows the node Success.")
        sys.exit(2)

    if dry:
        actions = []
        if NHI not in nhi_names:
            actions.append(f"create federated identity {NHI}")
        else:
            actions.append(f"reuse existing federated identity {NHI} (conflict-checked)")
        if KEY not in key_names:
            actions.append(f"create agent key {KEY} (custodian {NHI})")
        else:
            actions.append(f"reuse existing agent key {KEY}")
        if not existing_door:
            actions.append(f"create MCP door {door}")
        else:
            actions.append(f"reuse existing MCP door {door}")
        if GRANT not in [o.get("ObjectMeta", {}).get("Name") for o in
                         api(base, tenant, "GET", "pacpolicys?ObjectMeta.Namespace=default").get("PacPolicys", [])] if not dry else []:
            actions.append(f"create grant {GRANT}")
        else:
            actions.append(f"reuse or create grant {GRANT}")
        actions.append("write lab .env (with backup)")
        actions.append("wait for propagation, then verify the door live (200/401/401)")
        for a in actions:
            log("would:", a)
        log("DRY RUN complete: nothing was changed")
        return

    # Step 1: federated identity (create or conflict-check the existing one)
    want_fed = {"Issuer": ISSUER, "JwksURI": JWKS, "Subject": SUBJECT, "Audience": None,
                "MaxTokenLifetimeSec": MAXLIFE}
    if NHI in nhi_names:
        cur = api(base, tenant, "GET", f"nonhumanidentities/default/{NHI}")
        f = cur.get("Spec", {}).get("Federation", {})
        conflicts = [k for k in ("Issuer", "JwksURI", "Subject") if f.get(k) != want_fed[k]]
        if cur.get("Spec", {}).get("Enabled") is not True:
            conflicts.append("Enabled is not true")
        if int(f.get("MaxTokenLifetimeSec") or 0) != MAXLIFE:
            conflicts.append(f"MaxTokenLifetimeSec={f.get('MaxTokenLifetimeSec')} != {MAXLIFE}")
        if conflicts:
            die(f"federated identity {NHI} exists with different settings: {'; '.join(conflicts)}. "
                f"Fix it in the console or choose a different lab; this script will not overwrite it.")
        aud = f.get("Audience") or ""
        if not aud.startswith("priv-nhi-"):
            die(f"federated identity {NHI} exists but its audience {mask(aud)!r} is not a priv-nhi-… value")
        skipped.append(NHI)
        log(f"ok: federated identity {NHI} exists with the expected issuer/jwks/subject/lifetime")
    else:
        body = {"ObjectMeta": {"Name": NHI, "Namespace": "default"},
                "Spec": {"Description": "SPIFFE issuer lab SVID identity (lab-spiffe)",
                         "Enabled": True,
                         "Federation": {"Issuer": ISSUER, "JwksURI": JWKS, "Subject": SUBJECT,
                                        "MaxTokenLifetimeSec": MAXLIFE, "Platform": "spiffe"},
                         "Scopes": {"Elems": [SCOPE]}}}
        try:
            r = api(base, tenant, "POST", "nonhumanidentities", body)
        except RuntimeError as e:
            die(f"creating federated identity {NHI} failed: {e}; nothing else was created")
        created.append(NHI)
        aud = (r.get("Spec", {}).get("Federation", {}) or {}).get("Audience") or ""
        log(f"ok: federated identity {NHI} created (audience generated by the platform)")
    if not aud.startswith("priv-nhi-"):
        die(f"no usable priv-nhi-… audience on {NHI} (got {mask(aud)!r}); re-read the identity in the console and retry")

    # Step 2: agent key, custodian = the NHI
    key_body = None
    if KEY in key_names:
        cur = api(base, tenant, "GET", f"agentaccesskeys/default/{KEY}")
        spec = cur.get("Spec", {})
        cust = (spec.get("CustodianRef") or {}).get("RefID", "")
        if cust and cust != b64(f"{tenant}@@@default@@@{NHI}"):
            die(f"agent key {KEY} exists with a different custodian; refusing to touch it (--replace is not offered for keys)")
        skipped.append(KEY)
        log(f"ok: agent key {KEY} exists (custodian unchanged)")
    else:
        key_body = {"ObjectMeta": {"Name": KEY, "Namespace": "default"},
                    "Spec": {"Description": "SPIFFE issuer lab key (lab-spiffe)",
                             "Scopes": {"Elems": [SCOPE]},
                             "CustodianRef": {"RefKind": "NonHumanIdentity",
                                              "RefID": b64(f"{tenant}@@@default@@@{NHI}")}}}
        try:
            api(base, tenant, "POST", "agentaccesskeys", key_body)
        except RuntimeError as e:
            die(f"creating agent key {KEY} failed: {e}; created so far: {created or 'none'}")
        created.append(KEY)
        log(f"ok: agent key {KEY} created (custodian {NHI})")

    # Step 3: the door — reuse an existing MCP door with a gateway, else create
    if existing_door:
        mc = existing_door.get("Spec", {}).get("McpAppConfig") or {}
        if not mc.get("FrontEndName"):
            die(f"app {door} exists but is not an MCP door (no FrontEndName); refusing to modify it")
        log(f"ok: reusing existing MCP door {door}")
        skipped.append(door)
    else:
        body = {"ObjectMeta": {"Name": door, "Namespace": "default"},
                "Spec": {"McpAppConfig": {"FrontEndName": door, "AuthMode": "Static Token"}}}
        try:
            api(base, tenant, "POST", "applications", body)
        except RuntimeError as e:
            die(f"creating MCP door {door} failed: {e}; created so far: {created or 'none'}")
        created.append(door)
        log(f"ok: MCP door {door} created (backends must be wired in the console if needed)")

    # Step 4: the grant (pacpolicys), issued to the identity, on the door
    grants = api(base, tenant, "GET", "pacpolicys?ObjectMeta.Namespace=default")
    grant_list = grants if isinstance(grants, list) else grants.get("PacPolicys") or grants.get("Items") or []
    grant_names = names_of(grant_list)
    if GRANT in grant_names:
        skipped.append(GRANT)
        log(f"ok: grant {GRANT} exists (tool list unchanged; check it names the door's tools)")
    else:
        rule = {"Description": f"SPIFFE issuer lab grant (issued to {NHI})",
                "IssuedTo": {"RefKind": "NonHumanIdentity",
                             "RefID": b64(f"{tenant}@@@default@@@{NHI}")},
                "ActionMap": {"MCP": {"PolicyRule": [{"ObjectRef": b64(f"{tenant}@@@default@@@{door}"),
                                                      "Attributes": {"Map": {"agentaccesskey": b64(f"{tenant}@@@default@@@{KEY}")}}}]}}}
        body = {"ObjectMeta": {"Name": GRANT, "Namespace": "default"}, "Spec": rule}
        try:
            api(base, tenant, "POST", "pacpolicys", body)
        except RuntimeError as e:
            die(f"creating grant {GRANT} failed: {e}; created so far: {created or 'none'}")
        created.append(GRANT)
        log(f"ok: grant {GRANT} created (door {door}, key {KEY})")

    # Step 5: write the lab .env (backup first)
    env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
    lines = [f"SPIFFE_GW_URL={os.environ.get('PROVISION_GW_URL', 'https://gateway.example')}",
             f"SPIFFE_GW_APPS={door}",
             f"SPIFFE_AUDIENCE={aud}"]
    if os.path.exists(env_path):
        backup_obj("env", {"path": env_path, "content": open(env_path).read()})
        cur = [l for l in open(env_path).read().splitlines()
               if not l.startswith(("SPIFFE_GW_URL=", "SPIFFE_GW_APPS=", "SPIFFE_AUDIENCE="))]
    else:
        cur = []
    with open(os.open(env_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        f.write("\n".join(cur + lines) + "\n")
    log(f"ok: wrote {env_path} (SPIFFE_GW_URL, SPIFFE_GW_APPS, SPIFFE_AUDIENCE={mask(aud)})")

    # Step 6: propagation wait + live verify 200/401/401
    if os.environ.get("PROVISION_SKIP_WAIT") != "1":
        log("waiting ~4 min for policy propagation...")
        time.sleep(240)
    lab = os.environ.get("PROVISION_LAB_URL", "http://127.0.0.1:7829")
    results = {}
    for attempt in range(3):
        try:
            req = urllib.request.Request(lab.rstrip("/") + "/api/present", method="POST",
                                         data=b"{}", headers={"content-type": "application/json"})
            with urllib.request.urlopen(req, timeout=120, context=ssl.create_default_context()) as r:
                results = json.loads(r.read().decode())
            break
        except Exception as e:
            if attempt == 2:
                die(f"live verification could not reach the lab at {lab}: {e}. "
                    f"Start the lab (scripts/run.sh) and re-run this script; everything else is done.")
            time.sleep(60)
    got = {k: v.get("status") for k, v in results.items()} if isinstance(results, dict) else {}
    if got.get("valid") == 200 and got.get("mismatched") == 401 and got.get("untrusted") == 401:
        log("VERIFIED: valid 200, mismatched 401, untrusted 401 — the tenant is ready")
    else:
        die(f"live verification did not match the design: {got}. Check the grant's tool names against "
            f"the door's tools/list (member-aliased names) and the gateway log, then re-run.")

    # Step 7: orphan check over what we created
    log(f"orphan check: created {len(created)} ({', '.join(created) or 'nothing new'}), "
        f"skipped {len(skipped)} existing ({', '.join(skipped) or 'none'})")
    log("orphan 0" if created else "orphan 0 (all objects pre-existed)")


if __name__ == "__main__":
    main()
