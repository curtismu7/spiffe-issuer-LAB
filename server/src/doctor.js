// Preflight checks shared by `npm run doctor` and GET /api/health. Prints no secret and makes no outbound call.
// Each check: { id, level: 'pass' | 'info' | 'fail', detail }.
import { assertBindAllowed, bindHost, portProblem } from './safety.js';
import { netguardSelfTest } from './netguard.js';
import { readConfig } from './config.js';
import { MAX_LIFETIME_SEC, mintAll, verify } from './svid.js';

const PRIVATE_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi'];

export async function runChecks({ env = process.env, store } = {}) {
  const checks = [];
  const add = (id, level, detail) => checks.push({ id, level, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 26 ? 'pass' : 'fail', `v${process.versions.node} (need >= 26)`);

  const cfg = readConfig(env);
  add('config', cfg.problems.length ? 'fail' : 'pass', cfg.problems.length ? cfg.problems.join('; ') : 'settings are well formed');

  try { add('bind', 'pass', `${assertBindAllowed(bindHost(env), env)}${env.SPIFFE_BIND ? ' (SPIFFE_BIND opt-in)' : ' (loopback)'}`); } catch (e) { add('bind', 'fail', e.message); }
  const port = env.PORT === undefined || env.PORT === '' ? 7828 : Number(env.PORT);
  const problem = portProblem(port);
  add('port', problem ? 'fail' : 'pass', problem || `${port} is the allocated port`);

  if (store) {
    const jwks = store.jwks();
    const leaks = jwks.keys.flatMap((k) => Object.keys(k).filter((f) => PRIVATE_FIELDS.includes(f)));
    add('jwks-public-only', !leaks.length && jwks.keys.length === 1 && jwks.keys[0].kid === store.trusted.kid ? 'pass' : 'fail',
      leaks.length ? 'the published key set carries private fields' : 'the published JWKS holds the trusted key, public half only');
    add('untrusted-key', store.untrusted.kid !== store.trusted.kid && !jwks.keys.some((k) => k.kid === store.untrusted.kid) ? 'pass' : 'fail',
      'the untrusted key is a different key and is not published');
    add('keys-stored', store.persisted ? 'pass' : 'info', store.persisted ? 'signing keys are kept in the data directory' : 'the data directory is not writable: the keys last for this process only, so the JWKS changes at every start');

    const now = Date.now();
    const doorUrl = cfg.audienceFor(cfg.apps[0] || null);
    const issued = mintAll({ ...cfg, audience: doorUrl }, store, now);
    const by = Object.fromEntries(issued.map((t) => [t.id, t]));
    const v = (id) => verify(by[id].token, { jwks, issuer: cfg.issuer, audience: doorUrl, subject: cfg.validSub, now });
    const verdicts = { valid: v('valid'), mismatched: v('mismatched'), untrusted: v('untrusted') };
    const asDesigned = verdicts.valid.ok && !verdicts.mismatched.ok && verdicts.mismatched.reason === 'subject mismatch' && !verdicts.untrusted.ok;
    add('tokens', asDesigned ? 'pass' : 'fail', asDesigned ? 'the valid token verifies against the published JWKS; the mismatched and untrusted tokens fail' : `unexpected verdicts: ${JSON.stringify(Object.fromEntries(Object.entries(verdicts).map(([k, x]) => [k, x.ok ? 'ok' : x.reason])))}`);
    const longest = Math.max(...issued.map((t) => t.claims.exp - t.claims.iat));
    add('lifetime', longest <= MAX_LIFETIME_SEC ? 'pass' : 'fail', `longest token lifetime ${longest}s (cap ${MAX_LIFETIME_SEC}s)`);
  }

  const ng = await netguardSelfTest();
  add('netguard', ng.ok ? 'pass' : 'fail', ng.ok ? `blocked fetch, socket, socket-by-IP, dns lookup, dns resolve and udp to a non-loopback host (${ng.blocked}/6)` : ng.detail);

  add('public-url', 'info', cfg.publicUrlSet ? 'PUBLIC_URL is set: the issuer string is that origin' : 'PUBLIC_URL is not set: tokens carry a placeholder issuer, so Real cannot run (Mock still works)');
  add('real', 'info', cfg.realAvailable ? 'Real is configured: the door and PUBLIC_URL are set' : `Real is not configured${cfg.missing.length ? `, missing: ${cfg.missing.join(', ')}` : ''}`);
  return checks;
}

export const allPassed = (checks) => checks.every((c) => c.level !== 'fail');
