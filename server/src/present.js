// "Present to the gateway": send each token as the bearer to the configured MCP door (initialize + tools/list) and report what came back.
//   real: one exchange set per token through the shared hop (gatewayReal.js, vendored). Only the one configured origin is reachable.
//   mock: an in-process stand-in that applies the same checks to the published JWKS. It is a rehearsal, labelled MOCK, never the gateway.
import { createHttpClient, scrubDeep } from './gatewayReal.js';
import { bearerForDisplay, mockTrace, traceFromDoor } from './gatewayTrace.js';
import { verify } from './svid.js';
import { setAllowedOrigins } from './netguard.js';

const RPC_LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
const clip = (s, n = 300) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n);

// What the gateway said: a JSON-RPC or HTTP error message from the reply body, else its status line.
function wordsFromBody(body, headers) {
  const t = typeof body === 'string' ? body : null;
  const o = body && typeof body === 'object' ? body : null;
  const rpc = o && typeof o.error === 'object' ? o.error : null; // a JSON-RPC error object
  const msg = t ?? (o ? rpc?.message || o.message || o.error_description || (typeof o.error === 'string' ? o.error : null) : null);
  const www = headers?.['www-authenticate'];
  return clip([msg, www && `www-authenticate: ${www}`].filter(Boolean).join(' | '));
}

// The shared hop labels the auth header "agent key"; a JWT-SVID is not one.
const relabel = (wire) => wire.map((w) => ({
  ...w, request: { ...w.request, headers: Object.fromEntries(Object.entries(w.request.headers).map(([k, v]) => [k, String(v).replace('<agent key,', '<JWT-SVID,')])) },
}));

async function presentOne(url, t) {
  const wire = [];
  const client = createHttpClient({
    url, getAuth: () => ['Authorization', `Bearer ${t.token}`], timeoutMs: 15_000,
    clientInfo: { name: 'spiffe-issuer-lab', version: '0.1.0' }, onWire: (w) => wire.push(w),
  });
  let result;
  try {
    const r = await client.rpc('tools/list', {});
    result = { ok: true, tools: (Array.isArray(r?.tools) ? r.tools : []).map((x) => clip(x?.name, 80)).slice(0, 50) };
  } catch (err) {
    result = { ok: false, code: err?.code, httpStatus: err?.httpStatus ?? null, message: clip(err?.message) };
  }
  await client.close().catch(() => {});
  const clean = relabel(scrubDeep(wire, [t.token]));
  const decisive = [...clean].reverse().find((w) => w.http === 'POST' && w.response) || null;
  const status = decisive?.response?.status ?? null;
  const words = result.ok
    ? `accepted: tools/list returned ${result.tools.length} tool${result.tools.length === 1 ? '' : 's'}${result.tools.length ? ` (${result.tools.join(', ')})` : ''}`
    : (decisive ? wordsFromBody(decisive.response.body, decisive.response.headers) : '') || result.message;
  const trace = traceFromDoor({ ok: result.ok, wire: clean, refusal: { message: result.message } }, { rpcMethod: 'tools/list', credential: 'workload-token' });
  return { status, words: clip(words), reached: Boolean(decisive), error: result.ok ? null : result.code || 'refused', trace };
}

const rowOf = (t, r, source) => ({
  id: t.id, label: t.label, sub: t.claims.sub, iss: t.claims.iss, kid: t.header.kid, expect: t.expect,
  status: r.status, words: r.words, matched: r.status === t.expect, source, error: r.error, trace: r.trace,
});

export async function presentReal({ doorUrl, origin, tokens }) {
  setAllowedOrigins([origin]); // the one configured origin, only for the duration of the call
  try {
    const rows = [];
    for (const t of tokens) rows.push(rowOf(t, await presentOne(doorUrl, t), 'real'));
    return rows;
  } finally { setAllowedOrigins([]); }
}

// The rehearsal. The federation it applies (issuer, subject, audience) is the one the lab tells you to create; the words are the lab's own.
export function presentMock({ doorUrl, audience = doorUrl, store, cfg, tokens, now = Date.now() }) {
  const door = new URL(doorUrl);
  const mockUrl = `https://gateway.invalid${door.pathname}`;
  return tokens.map((t) => {
    const v = verify(t.token, { jwks: store.jwks(), issuer: cfg.issuer, audience, subject: cfg.validSub, now });
    const status = v.ok ? 200 : 401;
    const body = v.ok
      ? { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'mock_tool' }] } }
      : { error: 'unauthorized', message: `workload token rejected: ${v.reason}` };
    const words = v.ok ? 'accepted (MOCK): workload token accepted for this issuer and subject' : `${body.message} (MOCK words, not the gateway's)`;
    const trace = mockTrace({
      url: mockUrl, authorization: bearerForDisplay(t.token), rpc: RPC_LIST, status, body,
      decisions: [{ id: 'authenticated', label: 'Workload token', outcome: v.ok ? 'pass' : 'fail', evidence: v.ok ? 'issuer, key, audience, subject and lifetime all checked out' : v.reason }],
      record: null,
    });
    return rowOf(t, { status, words, reached: true, error: null, trace }, 'mock');
  });
}
