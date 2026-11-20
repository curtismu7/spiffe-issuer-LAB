// Safety rules. Pure functions plus the request guards.
//  1. Loopback bind only unless SPIFFE_BIND is set on purpose (the container sets it; the compose file publishes on 127.0.0.1 only).
//  2. Host header must be loopback or on LAB_ALLOWED_HOSTS (DNS-rebinding defence). ONE exception: the two public
//     key-publication paths (PUBLIC_PATHS) answer for any Host, because the gateway fetches them through whatever public
//     name the owner chose. They carry public keys only.
//  3. A write must be same-origin.
//  4. A request that arrives through a tunnel or reverse proxy (it carries one of the headers below) never reaches /api:
//     the API can mint tokens the gateway trusts, so it must not be reachable from the internet.
//  5. Hosts in shipped text are reserved (.invalid / .example) or loopback.

// The lab's own container port (what the server binds inside the container and what the host publishes with
// HOST_PORT). The host publish is 7829 (the shelf registry's row); the container port stays 7828 so the
// Dockerfile, healthcheck and docs keep one number.
export const PORT = 7828;
export const HOST_PORT = 7829;

export function isLoopbackHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(h);
}

export function bindHost(env = process.env) { return env.SPIFFE_BIND || '127.0.0.1'; }

export function assertBindAllowed(host, env = process.env) {
  if (isLoopbackHost(host) || env.SPIFFE_BIND) return host;
  throw new Error(`refusing to bind ${host}: loopback only. Set SPIFFE_BIND to opt in.`);
}

const FORBIDDEN_PORTS = new Set([8080, 5173, 3000, 3900, 4000, 4400, 4510, 4600, 4601, 4840, 18080, 19080, 19090]);
export function portProblem(port) {
  if (!Number.isInteger(port)) return 'PORT is not an integer';
  if (FORBIDDEN_PORTS.has(port)) return `port ${port} is reserved for something else`;
  if (port !== PORT) return `port ${port} is not this lab's allocated port ${PORT}`;
  return null;
}
export function resolvePort(env = process.env) {
  const port = env.PORT === undefined || env.PORT === '' ? PORT : Number(env.PORT);
  const problem = portProblem(port);
  if (problem) throw new Error(problem);
  return port;
}

export function isReservedHost(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  return /(^|\.)(invalid|example)$/.test(h);
}

const NETWORK_URL = /\b(?:https?|wss?|ftp|ssh|tcp|udp):\/\/(?:[^\s/@?#"'<>\\]*@)?([A-Za-z0-9][A-Za-z0-9.-]*)/gi;
// Every hostname in text that is not reserved or loopback. Empty = clean.
export function scanHosts(text) {
  const found = new Set();
  for (const m of String(text).matchAll(NETWORK_URL)) found.add(m[1].toLowerCase().replace(/\.$/, ''));
  return [...found].filter((h) => !isReservedHost(h) && !isLoopbackHost(h) && !/^<.*>$/.test(h)).sort();
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
export function allowedExtraHosts(env = process.env) {
  const extra = String(env.LAB_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  for (const h of extra) if (!HOSTNAME.test(h)) throw new Error(`LAB_ALLOWED_HOSTS: not a host name: ${h}`);
  return new Set(extra);
}

// The only paths that answer for any Host (public key material, read only).
export const PUBLIC_PATHS = new Set(['/.well-known/jwks.json', '/.well-known/openid-configuration']);

export function hostCheck(req, res, next) {
  if ((req.method === 'GET' || req.method === 'HEAD') && PUBLIC_PATHS.has(req.path)) return next();
  const raw = String(req.headers.host || '');
  const host = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.replace(/:\d+$/, '');
  if (!isLoopbackHost(host) && !allowedExtraHosts().has(host.toLowerCase())) {
    return res.status(403).json({ error: 'bad_host', message: 'Host must be loopback or on LAB_ALLOWED_HOSTS' });
  }
  next();
}

// Headers a tunnel or reverse proxy adds. The family lab-proxy sets none of these (it sets X-Forwarded-Host and -Proto only).
const TUNNEL_HEADERS = ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'forwarded', 'x-real-ip'];
export function apiNotThroughTunnel(req, res, next) {
  if (TUNNEL_HEADERS.some((h) => req.headers[h] !== undefined) || Object.keys(req.headers).some((h) => h.startsWith('ngrok-'))) {
    return res.status(403).json({ error: 'not_for_the_internet', message: 'The API is local only. Expose /.well-known/ (the public keys), never /api.' });
  }
  next();
}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export function sameOriginWrites(req, res, next) {
  if (!WRITE.has(req.method)) return next();
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return res.status(403).json({ error: 'cross_origin', message: 'writes must be same-origin' });
  const origin = req.headers.origin;
  if (origin) {
    // Behind the shared lab-proxy the browser origin is the proxy's while Host is the lab's own name: X-Forwarded-Host is set only by the proxy.
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
    let ok = false;
    try { ok = new URL(origin).host.toLowerCase() === host; } catch { /* malformed */ }
    if (!ok) return res.status(403).json({ error: 'cross_origin', message: 'writes must be same-origin' });
  }
  next();
}
