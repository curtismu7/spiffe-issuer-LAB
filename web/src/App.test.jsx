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
