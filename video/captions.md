<!--
  All the WORDING for the SPIFFE Issuer LAB recording. Edit the text under each heading, nothing else needs to change.
  take.py reads this file and fills in live values ({status}, {words}, {ttl}, {tools}, {date}) around whatever you write here.
  It must say what SCRIPT.md says; if a source changes, change SCRIPT.md first, then this file, then retake.

  Rules for editing safely:
  - Don't rename a "# Opening Slide" / "# Closing Slide" / "# Slide: <key>" / "# Step: <key>" heading, and don't rename a
    "## Title" / "## Text" / "## Lead" / "## Verdict" / "## Column A: ..." / "## Column B: ..." heading.
  - A "## Column A: <label>" or "## Column B: <label>" label IS shown on the slide as that column's heading.
  - Keep each bullet on its own line starting with "- ".
  - "---" on its own line separates one section from the next. Keep those.
  - No internal hostnames in this file (the repo is public). The page on screen shows the real hosts; internal viewers only.
  - A slide is held at most 10 seconds (owner standard, 2026-11-22): keep slide text to about 40 words (four words a second).
  - Say only what the run proved. The gateway gives no reason for a 401: say "it gives no reason", never "the cause", and do not claim the two refusals read the same (the mismatched one may differ).
-->

# Opening Slide

## Title
A short-lived signed token, not a stored secret

## Lead
Two ways through a gateway.

## Column A: A stored credential
- A string the agent keeps
- Works until revoked

## Column B: A SPIFFE JWT-SVID (signed token)
- A signed token naming its SPIFFE ID
- Short-lived, one audience
- Checked against a public key list

## Verdict
Demo uses the signed token. The lab mints test tokens: not SPIRE.

---

# Slide: setup

## Title
How Privilege is set up

## Lead
Read from Privilege on {date}; nothing changed.

## Column A: The Federated Identity
- Issuer, key list fetched by URL
- Subject: one SPIFFE ID (required claim)
- Audience: the door; scope mcp

## Column B: The key and the grant
- Agent key, custodian is that identity
- A grant on one door

## Verdict
Signed token, not a stored credential.

---

# Closing Slide

## Title
What this run just showed

## Lead
One token let in, two refused.

## Column A: What we did
- Public key list: one key
- Minted three tokens
- Got 200, then 401 and 401

## Column B: Why it matters
- No stored secret
- Two-minute token, one door

## Verdict
Limit: test tokens; no workload attested. Specs: SPIFFE JWT-SVID, RFC 7519, 7517, 6750, 9110.

---

# Step: intro

## Title
A real gateway, a test token

## Text
The tokens on this page go to one real gateway door, an MCP endpoint that guards a set of tools. This lab stands in for the agent: it minted and signed them itself. It is a token minter, not SPIRE; no workload is attested.

---

# Step: federation

## Title
What the gateway is told to trust

## Text
Four values: the issuer, where to fetch its public keys, the audience (the door this token is for), and the one SPIFFE ID allowed, the workload's name as a URI. The SPIFFE spec says sub is that ID and aud should be scoped to the receiving service.

---

# Step: jwks

## Title
The public key list

## Text
One key: its type, its public numbers (n and e) and a key id (kid). No d: no private half is published. A key list is just a JSON object with a keys array (RFC 7517).

---

# Step: valid

## Title
The valid token

## Text
The SPIFFE spec requires sub, aud and exp. This token also carries iss and iat. It expires {ttl} seconds after it was issued, and aud is the door.

---

# Step: mismatched

## Title
Mismatched: only the subject differs

## Text
Same key, same issuer, same audience. Only sub changed, to a different SPIFFE ID than the identity allows.

---

# Step: untrusted

## Title
Untrusted: only the key differs

## Text
The right SPIFFE ID, but signed with a second key. Its kid was never published in the key list.

---

# Step: present

## Title
Present all three

## Text
Present mints fresh tokens with these same claims and sends each in an Authorization: Bearer header on a real MCP request: initialize, then tools/list. The MCP spec requires the token on every request.

---

# Step: valid_result

## Title
Valid: HTTP {status}

## Text
The gateway accepted the token and answered with its tool list ({tools} tools). This is the gateway's own answer.

---

# Step: refused

## Title
Both wrong tokens: HTTP 401

## Text
The gateway refused each in its own words: {words}. It gives no reason for either 401, so this run does not say why. Each token differs from the valid one: the subject, or the key. MCP requires a 401 for an invalid token.

---

# Step: trace

## Title
The request as sent

## Text
The bearer header (the token itself is kept on the server and not shown), the JSON-RPC call, and what came back.

---

# Step: sample_present

## Title
SAMPLE: present all three

## Text
Present mints fresh tokens with these same claims and sends each to the mock stand-in as an Authorization: Bearer token: initialize, then tools/list. The real take sends them to a real MCP door.

---

# Step: sample_trace

## Title
The request as sent (mock)

## Text
The bearer header (in this mock trace the token is shortened; the real trace keeps it on the server and shows none of it), the JSON-RPC call, and what came back.

---

# Step: sample_intro

## Title
SAMPLE: a mock stand-in

## Text
This sample runs the lab in Mock mode. An in-process stand-in answers by its own rules, so nothing here is a gateway answer. The real take is recorded live.

---

# Step: sample_valid_result

## Title
Valid: HTTP {status} (mock)

## Text
The mock stand-in accepted the token and listed a tool. In the real take this is the gateway's own answer.

---

# Step: sample_refused

## Title
Both wrong tokens: 401 (mock)

## Text
The mock stand-in refused both, in its own words. In the real take these are the gateway's 401 answers.

---

# Step: sample_closing_lead

## Title
Sample closing lead

## Text
This SAMPLE ran the lab in Mock mode: one right token accepted, two wrong ones refused, by a stand-in.

---

# Step: sample_closing_bullet

## Title
Sample closing bullet

## Text
Presented each to the mock stand-in, not a gateway
