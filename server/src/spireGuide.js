// "Set it up on your side": the steps a person follows to put a real SPIRE behind a Privilege gateway, with THIS lab's trust domain, namespace and agent names
// filled in. Generic on purpose: placeholders in <angle brackets>, no host, tenant or audience of anyone's environment.
// What is verified: one real deployment (SPIRE 1.7.2 on Kubernetes, 2026-11-19) gave 200 for the registered SPIFFE ID and 401 for a different ID,
// a wrong audience, a tampered signature and no token. Your platform may differ in the attestation and publishing details.

export function buildGuide({ trustDomain, namespace, agent, otherAgent, serverUrl } = {}) {
  const td = trustDomain || '<trust-domain>';
  const ns = namespace || '<namespace>';
  const ag = agent || '<agent>';
  const other = otherAgent || '<other-agent>';
  const base = serverUrl || 'https://<your-spire-host>[/<prefix>]';
  const spiffeId = `spiffe://${td}/ns/${ns}/sa/${ag}`;
  const otherId = `spiffe://${td}/ns/${ns}/sa/${other}`;
  return {
    verified: 'Verified end to end on one real deployment (SPIRE 1.7.2 on Kubernetes, 2026-11-19): the registered SPIFFE ID gave 200 with tools/list; another ID, a wrong audience, a tampered signature and no token each gave 401. Your platform may differ.',
    steps: [
      {
        id: 'run',
        title: 'Run SPIRE with its OIDC discovery provider',
        body: [
          'For a rehearsal, press Start SPIRE below (a throwaway server on this machine). For the real thing, run the SPIRE server and the oidc-discovery-provider where your agents run.',
          'Set a trust domain and a jwt_issuer in the server config: the jwt_issuer string becomes the iss claim of every token. Keep the signing keys on persistent storage.',
          'Pin the SPIRE version you tested. One platform here ran 1.7.2 and a newer 1.12.x crashed on its volume ("unable to open database file").',
        ],
        code: ['jwt_issuer = "https://<the-issuer-you-want-in-iss>"'],
      },
      {
        id: 'publish',
        title: 'Publish the keys at a public https URL the gateway can reach',
        body: [
          `The gateway fetches the keys itself, so an internal-only address will not work. The default key path is <base>/keys and the discovery document is <base>/.well-known/openid-configuration. A path prefix such as ${'https://<host>/spire'} is fine.`,
          'The discovery document\'s own "issuer" is the provider\'s, not necessarily your jwt_issuer, and its jwks_uri can point at the wrong place behind a path-rewriting ingress. Trust <base>/keys, and the iss inside a real token.',
          'Put the base in this lab\'s .env as SPIRE_SERVER_URL, restart the lab, then press Test SPIRE server. A pass means the key set is public, has kid values, and holds no private key material.',
        ],
        code: [`SPIRE_SERVER_URL=${base}`, '# optional: SPIRE_AGENT_URL=https://<agent-or-health-origin>', '# optional: SPIRE_ALLOWED_HOSTS=https://<another-origin-that-serves-the-keys>'],
      },
      {
        id: 'register',
        title: 'Register the workload (and a wrong one to prove the refusal)',
        body: [
          `Register the agent under the SPIFFE ID the Federated Identity will name, and a second ID that must be refused. Attest the SPIRE agent however your platform allows (Kubernetes PSAT where RBAC permits, otherwise a join token).`,
          'Always ask for a token by explicit SPIFFE ID and audience. Two entries that share a selector make a plain fetch return whichever is listed first, which can be the wrong identity.',
        ],
        code: [
          `spire-server entry create -parentID <agent-spiffe-id> -spiffeID ${spiffeId} -selector <selector>`,
          `spire-server entry create -parentID <agent-spiffe-id> -spiffeID ${otherId} -selector <selector>`,
          `spire-agent api fetch jwt -socketPath <socket> -spiffeID ${spiffeId} -audience <audience-from-the-console>`,
        ],
      },
      {
        id: 'identity',
        title: 'Register the Federated Identity in Privilege',
        body: [
          'Console: Directory, Federated Identities, Register Identity. Token issuer type SPIFFE / SPIRE (JWT-SVID).',
          'Issuer: exactly the iss inside your tokens (your jwt_issuer). Subject: the SPIFFE ID of the workload.',
          'Key source: Fetch from URL, with the key URL from step 2. Never paste or pin the keys: SPIRE rotates its signing key and a pinned key breaks at the next rotation.',
          'Grant the mcp permission, save, then copy the generated audience: it is what you ask SPIRE to put in aud.',
        ],
        code: ['Issuer:  <the jwt_issuer>', `Subject: ${spiffeId}`, 'Key source: Fetch from URL  ->  <base>/keys'],
      },
      {
        id: 'prove',
        title: 'Prove it with five calls',
        body: [
          'Mint a token for the registered ID and call the gateway door. Expect 200 and a tool list. Then repeat with: the other ID, the right ID with a wrong audience, the right token with one character of the signature changed, and no token. Each must be 401.',
          'Never paste a token into a chat or a ticket. They are short-lived credentials.',
        ],
        code: [
          'curl -s -o /dev/null -w "%{http_code}\\n" -X POST https://<gateway>/<app>/mcp \\',
          '  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \\',
          '  -H "accept: application/json, text/event-stream" \\',
          '  -d \'{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}\'',
        ],
      },
    ],
  };
}
