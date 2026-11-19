import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNetguard } from './netguard.js';
import { createApp, startHttpServer } from './app.js';
import { createHealth } from './health.js';
import { allPassed, runChecks } from './doctor.js';
import { assertBindAllowed, bindHost, resolvePort } from './safety.js';
import { readConfig } from './config.js';
import { createKeyStore } from './keys.js';

installNetguard(); // before anything else can open a socket

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* no .env: every setting is optional */ }

const cfg = readConfig();
const store = createKeyStore({ dataDir: process.env.DATA_DIR || path.join(root, '.data'), alg: cfg.alg });
console.log(`[spiffe-issuer] signing keys ${store.created ? 'generated' : 'loaded'} (${store.alg}, ${store.persisted ? 'kept in the data directory' : 'NOT persisted: the data directory is not writable'})`);

const checks = await runChecks({ store });
if (!allPassed(checks)) {
  for (const c of checks.filter((x) => x.level === 'fail')) console.error(`[spiffe-issuer] refusing to start: ${c.id}: ${c.detail}`);
  process.exit(1);
}
const health = createHealth({ runChecks: () => runChecks({ store }) });
const host = assertBindAllowed(bindHost(), process.env);
const { url } = await startHttpServer({ port: resolvePort(), host, app: createApp({ store, health }) });
console.log(`[spiffe-issuer] lab listening on ${url}. Public keys: ${url}.well-known/jwks.json`);
console.log(`[spiffe-issuer] issuer ${cfg.issuer}${cfg.publicUrlSet ? '' : ' (PUBLIC_URL is not set: placeholder, Real cannot run)'}; Real ${cfg.realAvailable ? 'is configured' : 'is not configured'}`);
