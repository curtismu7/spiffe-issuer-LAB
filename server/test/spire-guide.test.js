import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGuide } from '../src/spireGuide.js';
import { baseEnv, startLab } from './helpers.js';

const text = (g) => JSON.stringify(g);

test('the guide has the five steps in order, fills in the lab\'s own values, and shows placeholders when there are none', () => {
  const g = buildGuide({ trustDomain: 'corp.example', namespace: 'agents', agent: 'mcp-agent', otherAgent: 'other-agent', serverUrl: 'https://host.example/spire' });
  assert.deepEqual(g.steps.map((s) => s.id), ['run', 'publish', 'register', 'identity', 'prove']);
  assert.ok(g.steps.every((s) => s.title && s.body.length && Array.isArray(s.code)));
  assert.ok(text(g).includes('spiffe://corp.example/ns/agents/sa/mcp-agent'));
  assert.ok(text(g).includes('spiffe://corp.example/ns/agents/sa/other-agent'));
  assert.ok(text(g).includes('SPIRE_SERVER_URL=https://host.example/spire'));
  const empty = buildGuide();
  assert.ok(text(empty).includes('SPIRE_SERVER_URL=https://<your-spire-host>[/<prefix>]'));
  assert.ok(text(empty).includes('spiffe://<trust-domain>/ns/<namespace>/sa/<agent>'));
});

test('the guide is honest about what was verified, and carries every lesson that cost time', () => {
  const g = buildGuide({});
  assert.match(g.verified, /one real deployment/);
  assert.match(g.verified, /200/);
  assert.match(g.verified, /401/);
  assert.match(g.verified, /may differ/);
  const t = text(g);
  assert.match(t, /explicit SPIFFE ID and audience/i, 'two entries sharing a selector return the wrong identity');
  assert.match(t, /Never paste or pin the keys/i, 'keys rotate');
  assert.match(t, /not necessarily your jwt_issuer/i, 'the discovery issuer is cosmetic');
  assert.match(t, /1\.12\.x crashed/, 'the version trap');
  assert.match(t, /internal-only address will not work/i);
});

test('the guide names no real host, tenant, audience, cluster or token: only .example hosts and <placeholders>', () => {
  const t = text(buildGuide({ trustDomain: 'corp.example', namespace: 'agents', agent: 'a', otherAgent: 'b' }));
  assert.doesNotMatch(t, /ping-devops|pingone\.com|pingidentity|priv-nhi-|ai-demo|cmuir|se-cluster|0428ba4f|4cb38c18/i);
  assert.doesNotMatch(t, /eyJ[A-Za-z0-9_-]{10,}/, 'no token');
  const hosts = [...t.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase());
  for (const h of hosts) assert.match(h, /\.example$|^localhost$|^127\./, `host ${h}`);
});

test('GET /api/spire/guide answers with the lab\'s settings filled in, and reports a bad SPIRE_SERVER_URL instead of hiding it', async () => {
  const lab = await startLab({ env: baseEnv({ PUBLIC_URL: 'https://issuer.example', SPIFFE_TRUST_DOMAIN: 'corp.example', SPIFFE_NAMESPACE: 'ns1', SPIFFE_AGENT: 'bot', SPIRE_SERVER_URL: 'https://host.example/spire' }) });
  try {
    const r = await lab.get('/api/spire/guide');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control'), /no-store/);
    const raw = await r.text();
    const g = JSON.parse(raw);
    assert.equal(g.mode, 'remote');
    assert.deepEqual(g.problems, []);
    assert.ok(raw.includes('spiffe://corp.example/ns/ns1/sa/bot'));
    assert.ok(raw.includes('SPIRE_SERVER_URL=https://host.example/spire'));
  } finally { await lab.close(); }

  const bad = await startLab({ env: baseEnv({ PUBLIC_URL: 'https://issuer.example', SPIRE_SERVER_URL: 'http://insecure.example' }) });
  try {
    const g = await (await bad.get('/api/spire/guide')).json();
    assert.equal(g.mode, 'invalid');
    assert.equal(g.problems.length, 1);
    assert.match(g.problems[0], /SPIRE_SERVER_URL must be an https URL/);
  } finally { await bad.close(); }
});
