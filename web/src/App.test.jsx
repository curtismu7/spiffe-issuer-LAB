import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "./App";

// Three tokens shaped like the server's (header.payload.signature, base64url); never a real signature.
const seg = (o) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const jwt = (kid, sub) => `${seg({ alg: "RS256", typ: "JWT", kid })}.${seg({ iss: "https://issuer.example", sub, aud: "https://gateway.example/door/mcp", iat: 1700000000, exp: 1700000120 })}.c2lnbmF0dXJl`;
const TOKENS = [
  { id: "valid", label: "Valid", why: "right everything", expect: 200, token: jwt("k1", "spiffe://lab.example/ns/agents/sa/mcp-agent") },
  { id: "mismatched", label: "Mismatched", why: "other id", expect: 401, token: jwt("k1", "spiffe://lab.example/ns/agents/sa/other-agent") },
  { id: "untrusted", label: "Untrusted", why: "unpublished key", expect: 401, token: jwt("k2", "spiffe://lab.example/ns/agents/sa/mcp-agent") },
].map((t) => ({ ...t, header: {}, claims: {} }));

const config = (extra = {}) => ({
  issuer: "https://spiffe-issuer.example", publicUrlSet: false, jwksUrl: "https://spiffe-issuer.example/.well-known/jwks.json", discoveryUrl: "x",
  trustDomain: "lab.example", validSub: "spiffe://lab.example/ns/agents/sa/mcp-agent", mismatchedSub: "spiffe://lab.example/ns/agents/sa/other-agent",
  audience: "https://gateway.example/your-app/mcp", app: null, apps: [], gatewayOrigin: null, alg: "RS256", ttlSeconds: 120, ttlClamped: false, audArray: false,
  untrustedMode: "key", trustedKid: "k1", untrustedKid: "k2", keysPersisted: true, missing: ["SPIFFE_GW_URL", "SPIFFE_GW_APPS", "PUBLIC_URL"], problems: [], ...extra,
});
const NO_SETTINGS = { source: "mock", realAvailable: false, realHint: "Real is not configured. Missing: SPIFFE_GW_URL, SPIFFE_GW_APPS, PUBLIC_URL. Mock still works.", version: "0.1.0", config: config() };
const REAL_SETTINGS = { source: "real", realAvailable: true, realHint: null, version: "0.1.0", config: config({ publicUrlSet: true, issuer: "https://issuer.example", gatewayOrigin: "https://gateway.example", apps: ["door", "second"], app: "door", audience: "https://gateway.example/door/mcp", missing: [] }) };

const trace = (source) => ({ source, request: { method: "POST", url: "https://gateway.invalid/door/mcp", headers: { authorization: "Bearer <JWT-SVID>" }, body: { jsonrpc: "2.0", method: "tools/list" } }, response: { status: 200, headers: {}, body: { result: { tools: [] } } }, decisions: [{ id: "authenticated", label: "Workload token", outcome: "pass", basis: source === "mock" ? "checked" : "inferred", evidence: "ok" }], record: null });
const rows = (source, statuses = [200, 401, 401]) => TOKENS.map((t, i) => ({
  id: t.id, label: t.label, sub: "spiffe://lab.example/ns/agents/sa/x", expect: t.expect, status: statuses[i], matched: statuses[i] === t.expect,
  words: statuses[i] === 200 ? "accepted: tools/list returned 1 tool (whoami)" : "workload token rejected: subject mismatch", source, trace: trace(source),
}));

function stub(info, { present } = {}) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b });
    if (url === "/api/info") return json(info);
    if (url === "/api/shelf") return json({ shelfUrl: null });
    if (url === "/api/mint") return json({ source: info.source, audience: info.config.audience, tokens: TOKENS });
    if (url === "/api/mode") return body.source === "real" && !info.realAvailable ? json({ error: "real_not_configured", message: info.realHint }, 409) : json({ source: body.source });
    if (url === "/api/present") return present ? present(body) : json({ source: info.source, audience: info.config.audience, tokens: TOKENS, rows: rows(info.source) });
    return json({}, 404);
  });
  return calls;
}
beforeEach(() => { window.location.hash = ""; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("the lab with no settings at all", () => {
  it("starts in Mock, shows the three tokens, says exactly what Real is missing, and the Real option is off", async () => {
    stub(NO_SETTINGS);
    render(<App />);
    expect(await screen.findByTestId("token-valid")).toBeInTheDocument();
    expect(screen.getByTestId("token-mismatched")).toBeInTheDocument();
    expect(screen.getByTestId("token-untrusted")).toBeInTheDocument();
    expect(screen.getByTestId("real-hint")).toHaveTextContent("Missing: SPIFFE_GW_URL, SPIFFE_GW_APPS, PUBLIC_URL");
    expect(screen.getByTestId("mode-badge")).toHaveTextContent("mock");
    expect(screen.getByTestId("sim-banner")).toHaveTextContent(/MINTS test JWT-SVIDs/);
    expect(screen.getByTestId("sim-banner")).toHaveTextContent(/not SPIRE/);
    expect(screen.getByTestId("federation")).toHaveTextContent("placeholder: set PUBLIC_URL");
    expect(screen.getByTestId("present")).toHaveTextContent("Rehearse against the mock gateway");
  });

  it("the rehearsal shows a 3-row table (200, 401, 401), every row labelled MOCK, and the trace panel", async () => {
    stub(NO_SETTINGS);
    render(<App />);
    fireEvent.click(await screen.findByTestId("present"));
    const table = await screen.findByTestId("results-table");
    for (const [id, status] of [["valid", "200"], ["mismatched", "401"], ["untrusted", "401"]]) {
      expect(within(screen.getByTestId(`row-${id}`)).getByTestId(`status-${id}`)).toHaveTextContent(status);
      expect(screen.getByTestId(`words-${id}`)).toHaveTextContent("MOCK");
    }
    expect(within(table).getAllByText("as designed")).toHaveLength(3);
    expect(screen.getAllByText(/What Privilege did/i).length).toBeGreaterThan(0);
  });

  it("the Real option is disabled until Real is configured, and the page keeps Mock", async () => {
    stub(NO_SETTINGS);
    render(<App />);
    await screen.findByTestId("token-valid");
    const select = screen.getByTestId("mode-select");
    expect(select.querySelector('option[value="real"]')?.disabled).toBe(true);
    expect(screen.getByTestId("mode-badge")).toHaveTextContent("mock");
  });
});

describe("Real configured", () => {
  it("opens in Real, shows the real banner, sends the chosen door, and labels each row REAL", async () => {
    const calls = stub(REAL_SETTINGS);
    render(<App />);
    expect(await screen.findByTestId("mode-badge")).toHaveTextContent("real");
    expect(screen.getByTestId("sim-banner")).toHaveTextContent("https://gateway.example");
    expect(screen.getByTestId("v-audience")).toHaveTextContent("https://gateway.example/door/mcp");
    expect(screen.getByTestId("present")).toHaveTextContent("Present to the gateway");
    fireEvent.change(screen.getByTestId("app-select"), { target: { value: "second" } });
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/mint").at(-1).body.app).toBe("second"));
    fireEvent.click(screen.getByTestId("present"));
    await screen.findByTestId("results-table");
    expect(calls.filter((c) => c.url === "/api/present").at(-1).body.app).toBe("second");
    expect(screen.getByTestId("words-valid")).toHaveTextContent("REAL");
    expect(screen.getByTestId("words-mismatched")).toHaveTextContent("workload token rejected: subject mismatch");
  });

  it("a row the gateway answers differently than designed is marked, not hidden", async () => {
    stub(REAL_SETTINGS, { present: () => ({ ok: true, status: 200, json: async () => ({ source: "real", audience: "a", tokens: TOKENS, rows: rows("real", [200, 200, 401]) }) }) });
    render(<App />);
    fireEvent.click(await screen.findByTestId("present"));
    await screen.findByTestId("results-table");
    expect(screen.getAllByText("not as designed")).toHaveLength(1);
    expect(screen.getAllByText("as designed")).toHaveLength(2);
  });

  it("an unreachable gateway shows the named error and the rows with no status, never a blank", async () => {
    const unreachable = rows("real", [null, null, null]).map((r) => ({ ...r, words: "MCP HTTP request unreachable (ECONNREFUSED)" }));
    stub(REAL_SETTINGS, { present: () => ({ ok: false, status: 502, json: async () => ({ error: "gateway_unreachable", message: "The gateway could not be reached: MCP HTTP request unreachable (ECONNREFUSED)", rows: unreachable, tokens: TOKENS }) }) });
    render(<App />);
    fireEvent.click(await screen.findByTestId("present"));
    expect(await screen.findByTestId("error")).toHaveTextContent("could not be reached");
    expect(screen.getByTestId("status-valid")).toHaveTextContent("no answer");
  });
});

describe("tokens", () => {
  it("copy writes to the clipboard and logs nothing", async () => {
    stub(NO_SETTINGS);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const spies = ["log", "info", "warn", "error", "debug"].map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    render(<App />);
    fireEvent.click(await screen.findByTestId("copy-valid"));
    await waitFor(() => expect(screen.getByTestId("copied-valid")).toHaveTextContent("Copied"));
    expect(writeText).toHaveBeenCalledWith(TOKENS[0].token);
    for (const s of spies) for (const call of s.mock.calls) expect(call.join(" ")).not.toContain(TOKENS[0].token);
  });

  it("each token is drawn through the shared JSON pane, decoded", async () => {
    stub(NO_SETTINGS);
    render(<App />);
    const card = await screen.findByTestId("token-valid");
    expect(card.querySelector("[data-testid='json-valid']")).not.toBeNull();
    expect(card).toHaveTextContent("spiffe://lab.example/ns/agents/sa/mcp-agent");
  });
});

describe("the SPIRE server control card", () => {
  const SPIRE_OK = { ok: true, tested: "local", testedAt: "2026-11-19T00:00:00.000Z", checks: [
    { name: "container", ok: true, detail: "spire-demo-server is running", ms: 3 },
    { name: "ready", ok: true, detail: "127.0.0.1:18081 accepts connections", ms: 1 },
  ] };
  const SPIRE_FAIL = { ok: false, tested: "local", testedAt: "2026-11-19T00:00:00.000Z", checks: [
    { name: "container", ok: false, detail: "spire-demo-server is not running (Docker may be unavailable)", ms: 2 },
    { name: "ready", ok: false, detail: "127.0.0.1:18081 is not accepting connections", ms: 1 },
  ] };

  it("renders the card, loads the education command, and the test button calls POST /api/spire/test with pass chips", async () => {
    const calls = stub(NO_SETTINGS);
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, body });
      const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b });
      if (url === "/api/info") return json(NO_SETTINGS);
      if (url === "/api/shelf") return json({ shelfUrl: null });
      if (url === "/api/mint") return json({ source: "mock", audience: NO_SETTINGS.config.audience, tokens: TOKENS });
      if (url === "/api/spire/command") return json({ command: "docker run -d --name spire-demo-server -p 127.0.0.1:18081:8080 ghcr.io/spiffe/spire-server:1.7.2 …", container: "spire-demo-server", image: "ghcr.io/spiffe/spire-server:1.7.2", port: 18081 });
      if (url === "/api/spire/test") return json(SPIRE_OK);
      return json({}, 404);
    });
    render(<App />);
    expect(await screen.findByTestId("spire-card")).toBeInTheDocument();
    expect(screen.getByTestId("spire-command")).toHaveTextContent("docker run -d --name spire-demo-server");
    expect(screen.getByTestId("spire-card")).toHaveTextContent("not tested");
    fireEvent.click(screen.getByTestId("spire-test"));
    const checks = await screen.findByTestId("spire-checks");
    expect(calls.filter((c) => c.url === "/api/spire/test").at(-1)).toBeTruthy();
    expect(within(screen.getByTestId("spire-check-container")).getByText("pass")).toBeInTheDocument();
    expect(within(screen.getByTestId("spire-check-ready")).getByText("127.0.0.1:18081 accepts connections")).toBeInTheDocument();
    expect(within(checks).getAllByText("pass")).toHaveLength(2);
    // with a pass, Start stays disabled
    expect(screen.getByTestId("spire-start")).toBeDisabled();
  });

  it("shows fail chips, enables Start only after a failed LOCAL test, and docker-unavailable is a named notice", async () => {
    stub(NO_SETTINGS);
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b });
      if (url === "/api/info") return json(NO_SETTINGS);
      if (url === "/api/shelf") return json({ shelfUrl: null });
      if (url === "/api/mint") return json({ source: "mock", audience: NO_SETTINGS.config.audience, tokens: TOKENS });
      if (url === "/api/spire/command") return json({ command: "docker run …" });
      if (url === "/api/spire/test") return json(SPIRE_FAIL);
      if (url === "/api/spire/start") return json({ ok: false, reason: "docker-unavailable", message: "Docker is not reachable from the lab." });
      return json({}, 404);
    });
    render(<App />);
    await screen.findByTestId("spire-card");
    expect(screen.getByTestId("spire-start")).toBeDisabled();
    fireEvent.click(screen.getByTestId("spire-test"));
    await screen.findByTestId("spire-checks");
    expect(within(screen.getByTestId("spire-checks")).getAllByText("fail")).toHaveLength(2);
    expect(screen.getByTestId("spire-start")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("spire-start"));
    expect(await screen.findByTestId("spire-docker-unavailable")).toHaveTextContent("Docker is not reachable");
    expect(screen.getByTestId("spire-card")).toHaveTextContent("fail"); // title chip stays at fail
  });

  it("buttons disable while a request runs", async () => {
    stub(NO_SETTINGS);
    globalThis.fetch = vi.fn(async (url) => {
      const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b });
      if (url === "/api/info") return json(NO_SETTINGS);
      if (url === "/api/shelf") return json({ shelfUrl: null });
      if (url === "/api/mint") return json({ source: "mock", audience: NO_SETTINGS.config.audience, tokens: TOKENS });
      if (url === "/api/spire/command") return json({ command: "docker run …" });
      if (url === "/api/spire/test") return new Promise((r) => setTimeout(() => r(json(SPIRE_OK)), 20));
      return json({}, 404);
    });
    render(<App />);
    await screen.findByTestId("spire-card");
    fireEvent.click(screen.getByTestId("spire-test"));
    expect(screen.getByTestId("spire-test")).toBeDisabled();
    expect(screen.getByTestId("spire-start")).toBeDisabled();
    expect(screen.getByTestId("spire-restart")).toBeDisabled();
    await screen.findByTestId("spire-checks");
    expect(screen.getByTestId("spire-test")).not.toBeDisabled();
  });
});

describe("the SPIRE card: set it up on your side, and testing your own SPIRE", () => {
  const GUIDE = {
    verified: "Verified end to end on one real deployment (SPIRE 1.7.2 on Kubernetes, 2026-11-19): the registered SPIFFE ID gave 200.",
    mode: "local", serverUrl: null, problems: [],
    steps: [
      { id: "run", title: "Run SPIRE with its OIDC discovery provider", body: ["Pin the SPIRE version you tested."], code: ['jwt_issuer = "https://<the-issuer-you-want-in-iss>"'] },
      { id: "publish", title: "Publish the keys at a public https URL the gateway can reach", body: ["The gateway fetches the keys itself."], code: ["SPIRE_SERVER_URL=https://<your-spire-host>[/<prefix>]"] },
      { id: "register", title: "Register the workload", body: ["Always ask for a token by explicit SPIFFE ID."], code: ["spire-server entry create -spiffeID spiffe://corp.example/ns/agents/sa/mcp-agent"] },
      { id: "identity", title: "Register the Federated Identity in Privilege", body: ["Never paste or pin the keys."], code: [] },
      { id: "prove", title: "Prove it with five calls", body: ["Each must be 401."], code: [] },
    ],
  };
  const REMOTE_OK = { ok: true, tested: "remote", testedAt: "2026-11-19T00:00:00.000Z", checks: [
    { name: "discovery", ok: true, detail: "HTTP 200, issuer https://host.example", ms: 5 },
    { name: "jwks", ok: true, detail: "1 key (ES256) at https://host.example/spire/keys (default path <base>/keys).", ms: 4 },
    { name: "agent", ok: false, detail: "not configured (SPIRE_AGENT_URL is unset); optional", ms: 0 },
  ] };

  const mount = ({ guide = GUIDE, test = REMOTE_OK, start } = {}) => {
    stub(NO_SETTINGS);
    globalThis.fetch = vi.fn(async (url) => {
      const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b });
      if (url === "/api/info") return json(NO_SETTINGS);
      if (url === "/api/shelf") return json({ shelfUrl: null });
      if (url === "/api/mint") return json({ source: "mock", audience: NO_SETTINGS.config.audience, tokens: TOKENS });
      if (url === "/api/spire/command") return json({ command: "docker run …" });
      if (url === "/api/spire/guide") return guide ? json(guide) : json({}, 404);
      if (url === "/api/spire/test") return json(test);
      if (url === "/api/spire/start" || url === "/api/spire/restart") return json(start);
      return json({}, 404);
    });
    return render(<App />);
  };

  it("shows the five setup steps in order, with their code, and says what was verified", async () => {
    mount();
    const guide = await screen.findByTestId("spire-guide");
    expect(screen.getByTestId("spire-verified")).toHaveTextContent("Verified end to end on one real deployment");
    const steps = within(guide).getAllByTestId(/^spire-step-/).map((el) => el.getAttribute("data-testid"));
    expect(steps).toEqual(["spire-step-run", "spire-step-publish", "spire-step-register", "spire-step-identity", "spire-step-prove"]);
    expect(within(screen.getByTestId("spire-step-register")).getByText(/spiffe:\/\/corp.example\/ns\/agents\/sa\/mcp-agent/)).toBeInTheDocument();
    expect(within(screen.getByTestId("spire-step-publish")).getByText(/SPIRE_SERVER_URL=https:\/\/<your-spire-host>/)).toBeInTheDocument();
    expect(guide.tagName).toBe("DETAILS");
    expect(guide.open).toBe(false); // folded away until asked for
  });

  it("the card still works when the guide cannot be loaded", async () => {
    mount({ guide: null });
    await screen.findByTestId("spire-card");
    expect(screen.queryByTestId("spire-guide")).toBeNull();
    expect(screen.getByTestId("spire-test")).not.toBeDisabled();
  });

  it("testing your own SPIRE: names the mode and the URL, never offers to start a local one, and says what a pass does and does not prove", async () => {
    mount({ guide: { ...GUIDE, mode: "remote", serverUrl: "https://host.example/spire" } });
    await screen.findByTestId("spire-card");
    expect(screen.getByTestId("spire-mode")).toHaveTextContent("Cluster SPIRE");
    expect(screen.getByTestId("spire-mode")).toHaveTextContent("https://host.example/spire");
    expect(screen.queryByTestId("spire-command")).toBeNull();
    expect(screen.getByTestId("spire-start")).toBeDisabled();
    expect(screen.getByTestId("spire-restart")).toBeDisabled();
    fireEvent.click(screen.getByTestId("spire-test"));
    await screen.findByTestId("spire-checks");
    expect(within(screen.getByTestId("spire-check-jwks")).getByText(/1 key \(ES256\) at https:\/\/host.example\/spire\/keys/)).toBeInTheDocument();
    expect(screen.getByTestId("spire-remote-caveat")).toHaveTextContent("cannot prove the server is SPIRE");
    // a pass with the optional agent row "not configured" is still a pass overall
    expect(screen.getByTestId("spire-card")).toHaveTextContent("pass");
    expect(screen.getByTestId("spire-start")).toBeDisabled();
  });

  it("an invalid SPIRE_SERVER_URL is shown as a problem, not hidden behind the local mode", async () => {
    mount({ guide: { ...GUIDE, mode: "invalid", problems: ["SPIRE_SERVER_URL must be an https URL with no credentials, query or fragment"] },
      test: { ok: false, tested: "invalid", testedAt: "2026-11-19T00:00:00.000Z", checks: [{ name: "settings", ok: false, detail: "SPIRE_SERVER_URL must be an https URL", ms: 0 }] } });
    await screen.findByTestId("spire-card");
    expect(screen.getByTestId("spire-settings-problems")).toHaveTextContent("SPIRE_SERVER_URL must be an https URL");
    expect(screen.getByTestId("spire-mode")).toHaveTextContent("SPIRE_SERVER_URL is invalid");
    expect(screen.getByTestId("spire-start")).toBeDisabled();
    fireEvent.click(screen.getByTestId("spire-test"));
    await screen.findByTestId("spire-checks");
    expect(within(screen.getByTestId("spire-check-settings")).getByText("fail")).toBeInTheDocument();
    expect(screen.queryByTestId("spire-remote-caveat")).toBeNull();
  });

  it("a server that refuses to start a local SPIRE (the URL is set) gets a named notice, and a successful start shows the ready result", async () => {
    mount({ guide: { ...GUIDE, mode: "local" }, test: { ok: false, tested: "local", testedAt: "x", checks: [{ name: "container", ok: false, detail: "not running", ms: 1 }, { name: "ready", ok: false, detail: "refused", ms: 1 }] },
      start: { ok: false, reason: "not-local", message: "SPIRE_SERVER_URL is set, so this card tests your own SPIRE and will not start a local demo one." } });
    await screen.findByTestId("spire-card");
    fireEvent.click(screen.getByTestId("spire-test"));
    await screen.findByTestId("spire-checks");
    fireEvent.click(screen.getByTestId("spire-start"));
    expect(await screen.findByTestId("spire-not-local")).toHaveTextContent("SPIRE_SERVER_URL is set");
    expect(screen.queryByTestId("spire-start-error")).toBeNull();
  });

  it("a successful local start replaces the failed result with the passing one", async () => {
    const up = { ok: true, tested: "local", testedAt: "x", checks: [{ name: "container", ok: true, detail: "running", ms: 1 }, { name: "ready", ok: true, detail: "127.0.0.1:18081/ready answered 200", ms: 1 }] };
    mount({ guide: GUIDE, test: { ...up, ok: false, checks: up.checks.map((c) => ({ ...c, ok: false })) }, start: { ok: true, started: true, test: up } });
    await screen.findByTestId("spire-card");
    fireEvent.click(screen.getByTestId("spire-test"));
    await screen.findByTestId("spire-checks");
    expect(within(screen.getByTestId("spire-checks")).getAllByText("fail")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("spire-start"));
    expect(await screen.findByTestId("spire-start-ok")).toHaveTextContent("ready");
    await waitFor(() => expect(within(screen.getByTestId("spire-checks")).getAllByText("pass")).toHaveLength(2));
  });
});

describe("the SPIRE card: choose Docker or the cluster SPIRE", () => {
  const STEPS = [{ id: "run", title: "Run SPIRE", body: ["x"], code: [] }];
  const KUBECTL = [{ label: "Restart", command: "kubectl -n <namespace> rollout restart statefulset/spire-server" }];
  const viewOf = (target, clusterAvailable = true) => ({ target, serverUrl: clusterAvailable ? "https://host.example/spire" : null,
    options: { docker: { available: true }, cluster: { available: clusterAvailable, reason: clusterAvailable ? null : "SPIRE_SERVER_URL is not set in this lab's .env" } } });

  const mount = ({ start = "cluster", clusterAvailable = true, switchTo, svidStatus = { available: false, problems: [] }, svidResponse = {} } = {}) => {
    stub(NO_SETTINGS);
    const calls = [];
    let current = viewOf(start, clusterAvailable);
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, body });
      const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b });
      if (url === "/api/info") return json(NO_SETTINGS);
      if (url === "/api/shelf") return json({ shelfUrl: null });
      if (url === "/api/mint") return json({ source: "mock", audience: NO_SETTINGS.config.audience, tokens: TOKENS });
      if (url === "/api/spire/command") return json({ command: "docker run …", kubectl: KUBECTL });
      if (url === "/api/spire/guide") return json({ verified: "v", steps: STEPS, mode: current.options.cluster.available ? "remote" : "local", target: current.target, serverUrl: current.serverUrl, problems: [] });
      if (url === "/api/spire/target" && init.method === "POST") {
        if (switchTo?.status) return json({ ok: false, error: "cluster_not_configured", message: switchTo.message }, switchTo.status);
        current = { ...current, target: body.target };
        return json(current);
      }
      if (url === "/api/spire/target") return json(current);
      if (url === "/api/spire/test") return json({ ok: true, tested: current.target === "docker" ? "local" : "remote", target: current.target, testedAt: "x", checks: [{ name: "container", ok: true, detail: "up", ms: 1 }] });
      if (url === "/api/spire/demo-svid/status") return json(svidStatus);
      if (url === "/api/spire/demo-svid" && init.method === "POST") return json(svidResponse, 200);
      return json({}, 404);
    });
    render(<App />);
    return calls;
  };

  it("starts on the cluster when one is configured: kubectl commands shown, Docker command hidden, start and restart off", async () => {
    mount();
    await screen.findByTestId("spire-card");
    await waitFor(() => expect(screen.getByTestId("spire-target-cluster")).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByTestId("spire-target-docker")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("spire-mode")).toHaveTextContent("Cluster SPIRE");
    expect(screen.getByTestId("spire-mode")).toHaveTextContent("https://host.example/spire");
    expect(screen.getByTestId("spire-kubectl")).toHaveTextContent("kubectl -n <namespace> rollout restart");
    expect(screen.queryByTestId("spire-command")).toBeNull();
    expect(screen.getByTestId("spire-start")).toBeDisabled();
    expect(screen.getByTestId("spire-restart")).toBeDisabled();
  });

  it("switching to Docker posts the choice, clears the old result, reloads the guide, and shows the Docker command", async () => {
    const calls = mount();
    await screen.findByTestId("spire-card");
    fireEvent.click(await screen.findByTestId("spire-test"));
    await screen.findByTestId("spire-checks");
    fireEvent.click(screen.getByTestId("spire-target-docker"));
    await waitFor(() => expect(screen.getByTestId("spire-target-docker")).toHaveAttribute("aria-pressed", "true"));
    expect(calls.find((c) => c.url === "/api/spire/target" && c.body)?.body).toEqual({ target: "docker" });
    expect(calls.filter((c) => c.url === "/api/spire/guide").length).toBe(2);
    expect(screen.queryByTestId("spire-checks")).toBeNull();
    expect(screen.getByTestId("spire-mode")).toHaveTextContent("Docker demo SPIRE");
    expect(screen.getByTestId("spire-command")).toBeInTheDocument();
    expect(screen.queryByTestId("spire-kubectl")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("spire-restart")).not.toBeDisabled());
  });

  it("with no cluster configured the Cluster choice is disabled with the reason, and Docker is the selection", async () => {
    mount({ start: "docker", clusterAvailable: false });
    await screen.findByTestId("spire-card");
    await waitFor(() => expect(screen.getByTestId("spire-target-docker")).toHaveAttribute("aria-pressed", "true"));
    const cluster = screen.getByTestId("spire-target-cluster");
    expect(cluster).toBeDisabled();
    expect(cluster.getAttribute("title")).toMatch(/SPIRE_SERVER_URL is not set/);
    expect(screen.getByTestId("spire-cluster-off")).toHaveTextContent("SPIRE_SERVER_URL is not set");
  });

  it("a refused switch keeps the old selection and shows the server's message", async () => {
    mount({ start: "docker", switchTo: { status: 409, message: "The cluster SPIRE is not configured" } });
    await screen.findByTestId("spire-card");
    await waitFor(() => expect(screen.getByTestId("spire-target-docker")).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(screen.getByTestId("spire-target-cluster"));
    expect(await screen.findByTestId("error")).toHaveTextContent("The cluster SPIRE is not configured");
    expect(screen.getByTestId("spire-target-docker")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("spire-target-cluster")).toHaveAttribute("aria-pressed", "false");
  });

  it("with the demo token service configured, the get-SVID button shows the verification checks, the claims, and the raw token folded away", async () => {
    const svid = { ok: true, token: "header.payload.sig (not a real token in tests)",
      claims: { sub: "spiffe://demo/external", aud: ["priv-nhi-abcdefghij0123456789"], exp: 1, iat: 1 },
      verification: { ok: true, checks: [
        { name: "shape", ok: true, detail: "ES256" },
        { name: "signature", ok: true, detail: "verifies against the published key" },
        { name: "subject", ok: true, detail: "spiffe://demo/external" },
      ] } };
    const calls = mount({ svidStatus: { available: true, problems: [] }, svidResponse: svid });
    await screen.findByTestId("spire-card");
    expect(screen.getByTestId("spire-demo-svid")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("spire-svid-get"));
    const result = await screen.findByTestId("spire-svid-result");
    expect(within(result).getAllByText("pass").length).toBe(3);
    expect(screen.getByTestId("spire-svid-claims")).toHaveTextContent("spiffe://demo/external");
    // the raw token is present but folded away inside a closed details
    const details = within(result).getByText("Raw token (short-lived; a gateway would present it as the bearer)").closest("details");
    expect(details.open).toBe(false);
    // the invite key is never in the page
    expect(document.body.textContent).not.toContain("tokk_");
    expect(calls.filter((c) => c.url === "/api/spire/demo-svid")).toHaveLength(1);
  });

  it("with the demo token service unconfigured, the option is visibly off and nothing is fetched", async () => {
    const calls = mount({ svidStatus: { available: false, problems: [] } });
    await screen.findByTestId("spire-card");
    expect(screen.getByTestId("spire-demo-svid-off")).toHaveTextContent(/not configured/);
    expect(screen.queryByTestId("spire-svid-get")).toBeNull();
    expect(calls.filter((c) => c.url === "/api/spire/demo-svid")).toHaveLength(0);
  });
});
