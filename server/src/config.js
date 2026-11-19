// Settings. Sources, lowest to highest: the one shared settings file (~/Development/.env, or STANDALONE_ENV), then the process
// environment (the lab's own .env beside the compose file reaches the container this way). Only SPIFFE_* keys and PUBLIC_URL are
// taken; nothing else in the shared file is read into the lab. No value is ever logged. The lab holds no secret of its own here:
// the signing keys live in keys.js, and the door needs no agent key (the JWT-SVID is the credential).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { readFileSettings } from './gatewayReal.js';
import { ALGS } from './keys.js';
import { MAX_LIFETIME_SEC, spiffeId } from './svid.js';
import { isLoopbackHost } from './safety.js';

export const settingsPath = (env = process.env) => env.STANDALONE_ENV || path.join(os.homedir(), 'Development', '.env');
const fileText = (env) => { try { return fs.readFileSync(settingsPath(env), 'utf8'); } catch { return ''; } };

const SEGMENT = /^[A-Za-z0-9._-]{1,63}$/;
const DOMAIN = /^[a-z0-9]([a-z0-9.-]{0,253}[a-z0-9])?$/;
const APP = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const PLACEHOLDER_PUBLIC_URL = 'https://spiffe-issuer.example';
export const PLACEHOLDER_AUDIENCE = 'https://gateway.example/your-app/mcp';

// https, or http on loopback only (a local check). Returns the origin without a trailing slash, or null.
export function cleanOrigin(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname)))) return null;
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  return u.origin;
}

export function readConfig(env = process.env) {
  const text = fileText(env);
  const fromFile = (() => { try { return parseEnv(text); } catch { return {}; } })();
  const pick = (k) => String(env[k] ?? fromFile[k] ?? '').trim();
  const problems = [];
  const bad = (msg) => problems.push(msg);

  const trustDomain = (pick('SPIFFE_TRUST_DOMAIN') || 'lab.example').toLowerCase();
  if (!DOMAIN.test(trustDomain)) bad('SPIFFE_TRUST_DOMAIN must be a lowercase DNS-style name');
  const seg = (k, dflt) => { const v = pick(k) || dflt; if (!SEGMENT.test(v)) bad(`${k} must be 1-63 letters, digits, dot, dash or underscore`); return v; };
  const namespace = seg('SPIFFE_NAMESPACE', 'agents');
  const agent = seg('SPIFFE_AGENT', 'mcp-agent');
  const otherAgent = seg('SPIFFE_OTHER_AGENT', 'other-agent');
  if (otherAgent === agent) bad('SPIFFE_OTHER_AGENT must differ from SPIFFE_AGENT');

  const alg = pick('SPIFFE_ALG') || 'RS256';
  if (!ALGS.includes(alg)) bad(`SPIFFE_ALG must be one of ${ALGS.join(', ')}`);
  const ttlRaw = pick('SPIFFE_TTL_SECONDS') || '120';
  let ttlSeconds = Number(ttlRaw);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) { bad('SPIFFE_TTL_SECONDS must be a whole number of seconds'); ttlSeconds = 120; }
  const ttlClamped = ttlSeconds > MAX_LIFETIME_SEC;
  if (ttlClamped) ttlSeconds = MAX_LIFETIME_SEC;
  const untrustedMode = pick('SPIFFE_UNTRUSTED') || 'key';
  if (!['key', 'issuer'].includes(untrustedMode)) bad('SPIFFE_UNTRUSTED must be key or issuer');
  const audArray = /^1$|^true$/i.test(pick('SPIFFE_AUD_ARRAY'));

  const publicRaw = String(env.PUBLIC_URL ?? '').trim();
  let issuer = PLACEHOLDER_PUBLIC_URL;
  let publicUrlSet = false;
  if (publicRaw) {
    const o = cleanOrigin(publicRaw);
    if (o) { issuer = o; publicUrlSet = true; } else bad('PUBLIC_URL must be an https origin with no path (http only on loopback)');
  }

  // The gateway door: the shared hop's own loader reads SPIFFE_GW_URL / SPIFFE_GW_APPS (the lab needs no agent key).
  let gwText = text;
  for (const [k, v] of Object.entries(env)) if (k.startsWith('SPIFFE_GW_') && v) gwText += `\n${k}=${v}`;
  const gw = readFileSettings(gwText, 'SPIFFE');
  const gatewayOrigin = gw.SPIFFE_GW_URL ? cleanOrigin(gw.SPIFFE_GW_URL) : null;
  if (gw.SPIFFE_GW_URL && !gatewayOrigin) bad('SPIFFE_GW_URL must be an https origin with no path (http only on loopback)');
  const apps = String(gw.SPIFFE_GW_APPS || '').split(',').map((a) => a.trim()).filter(Boolean);
  if (apps.some((a) => !APP.test(a))) bad('SPIFFE_GW_APPS must list door names (lowercase letters, digits, dashes), comma separated');
  const doorApps = apps.filter((a) => APP.test(a));
  const audienceOverride = pick('SPIFFE_AUDIENCE');
  if (audienceOverride && !/^https?:\/\/\S+$/.test(audienceOverride)) bad('SPIFFE_AUDIENCE must be a URL');

  const missing = [
    !gw.SPIFFE_GW_URL && 'SPIFFE_GW_URL', !doorApps.length && 'SPIFFE_GW_APPS', !publicUrlSet && 'PUBLIC_URL',
  ].filter(Boolean);
  const realAvailable = missing.length === 0 && Boolean(gatewayOrigin) && !problems.length;
  const realHint = realAvailable ? null
    : `Real is not configured. ${missing.length ? `Missing: ${missing.join(', ')}.` : problems.join('; ')} Set them in the lab's .env (see the README), then restart the lab. Mock still works.`;

  const audienceFor = (app) => audienceOverride || (gatewayOrigin && app ? `${gatewayOrigin}/${app}/mcp` : PLACEHOLDER_AUDIENCE);
  return {
    problems, missing, realAvailable, realHint, gatewayOrigin, apps: doorApps, publicUrlSet, audienceOverride,
    issuer, trustDomain, namespace, agent, otherAgent, alg, ttlSeconds, ttlClamped, untrustedMode, audArray,
    validSub: spiffeId(trustDomain, namespace, agent), mismatchedSub: spiffeId(trustDomain, namespace, otherAgent),
    jwksUrl: `${issuer}/.well-known/jwks.json`, discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    audienceFor,
    // The app the door call and the audience use: the asked-for one if it is configured, else the first.
    appFor: (asked) => (doorApps.includes(asked) ? asked : doorApps[0] || null),
  };
}

// What the browser may see: every value, no function. No secret exists in the config.
export function publicConfig(cfg, store, app) {
  return {
    issuer: cfg.issuer, publicUrlSet: cfg.publicUrlSet, jwksUrl: cfg.jwksUrl, discoveryUrl: cfg.discoveryUrl,
    trustDomain: cfg.trustDomain, validSub: cfg.validSub, mismatchedSub: cfg.mismatchedSub,
    audience: cfg.audienceFor(app), app, apps: cfg.apps, gatewayOrigin: cfg.gatewayOrigin,
    alg: cfg.alg, ttlSeconds: cfg.ttlSeconds, ttlClamped: cfg.ttlClamped, audArray: cfg.audArray, untrustedMode: cfg.untrustedMode,
    trustedKid: store.trusted.kid, untrustedKid: store.untrusted.kid, keysPersisted: store.persisted,
    missing: cfg.missing, problems: cfg.problems,
  };
}
