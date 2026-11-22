<!--
  All the WORDING for the SPIFFE Issuer LAB recording. Edit the text under each heading, nothing else needs to change.
  take.py reads this file and fills in live values ({status}, {words}, {ttl}, {tools}) around whatever you write here.
  It must say what SCRIPT.md says; if a source changes, change SCRIPT.md first, then this file, then retake.

  Rules for editing safely:
  - Don't rename a "# Opening Slide" / "# Closing Slide" / "# Slide: <key>" / "# Step: <key>" heading, and don't rename a
    "## Title" / "## Text" / "## Lead" / "## Verdict" / "## Column A: ..." / "## Column B: ..." heading.
  - A "## Column A: <label>" or "## Column B: <label>" label IS shown on the slide as that column's heading.
  - Keep each bullet on its own line starting with "- ".
  - "---" on its own line separates one section from the next. Keep those.
  - No internal hostnames in this file (the repo is public). The page on screen shows the real hosts; internal viewers only.
  - A slide is held at most 10 seconds (owner standard, 2026-11-22): keep slide text to about 75 words.
-->

# Opening Slide

## Title
A short-lived signed token, not a stored secret

## Lead
Two ways to let an agent through a gateway.

## Column A: A stored credential
- A string the agent keeps in its configuration
- Whoever holds it is the agent
- It works until someone revokes it

## Column B: A SPIFFE JWT-SVID (signed token)
- The agent presents a signed token naming its SPIFFE ID
- It expires in minutes and is for one audience
- The gateway checks it against a public key list it fetches

## Verdict
This demo uses the signed token. The lab only mints test tokens: it is not SPIRE.

---

# Slide: setup

## Title
How Privilege is set up

## Lead
Read from Privilege on {date}; nothing changed.

## Column A: The Federated Identity
- Issuer: the host that publishes the key list
- Keys fetched from that URL
- Subject: one SPIFFE ID (required claim)
- Audience: the door URL; scope mcp

## Column B: The key and the grant
- An agent key whose custodian is that identity
- No API key, no secret on the agent
- A grant on one door
- Lifetime capped at 300 seconds

## Verdict
Ping: a Federated Identity authenticates with a signed token instead of a stored credential.

---

# Closing Slide

## Title
What this run just showed

## Lead
One right token let in, two wrong ones refused.

## Column A: What we did
- Showed the public key list: one key
- Minted three tokens: right, wrong ID, unpublished key
- Presented each to the door
- Got 200 with tools, then 401 and 401

## Column B: Why it matters
- No stored secret on the agent
- Expires in two minutes, names one door
- Wrong identity or unpublished key: refused

## Verdict
Limit: this lab minted the tokens; in production SPIRE issues them. Specs: SPIFFE JWT-SVID, RFC 7519, 7517, 6750, 9110.

---

# Step: intro

## Title
A real gateway, a test token

## Text
The tokens on this page are sent to one real gateway door (an MCP endpoint). This lab minted and signed them itself: it is a token minter, not SPIRE, and no workload is attested.

---

# Step: federation

## Title
What the gateway is told to trust

## Text
Four values: the issuer, where to fetch its public keys, the audience (the door this token is for), and the one SPIFFE ID allowed. The SPIFFE spec says sub is the workload's SPIFFE ID and aud is scoped to the receiving service.

---

# Step: jwks

## Title
The public key list

## Text
One key: its type, its public numbers (n and e) and a key id (kid). There is no d: the private half never leaves the lab. A key list is just a JSON object with a keys array (RFC 7517).

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
The right SPIFFE ID, but signed with a second key. Its kid is not in the published list, so no one can check it.

---

# Step: present

## Title
Present all three

## Text
Each token goes in an Authorization: Bearer header on a real MCP request: initialize, then tools/list. The MCP spec requires the token on every request.

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
Both are refused in the gateway's own words: "{words}". It names no reason, so the cause is the one difference we built in. RFC 9110: a 401 to a request with credentials means authorization was refused.

---

# Step: trace

## Title
The request as sent

## Text
The bearer header (the token itself is kept on the server and not shown), the JSON-RPC call, and what came back.

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
This sample runs the lab in Mock mode. An in-process stand-in applies the same checks, so nothing here is a gateway answer. The real take is recorded live.

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
The mock stand-in refused both, for the one difference built in. In the real take these are the gateway's 401 answers.

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
