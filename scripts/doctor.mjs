// Preflight: the same checks GET /api/health reports from, plus whether the port is free.
// Prints only pass/fail lines, never the value of a setting or a key. Exit 1 on any failure. Needs no network.
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* optional */ }

const { runChecks } = await import(pathToFileURL(path.join(root, 'server/src/doctor.js')));
const { readConfig } = await import(pathToFileURL(path.join(root, 'server/src/config.js')));
const { createKeyStore } = await import(pathToFileURL(path.join(root, 'server/src/keys.js')));

const store = createKeyStore({ dataDir: process.env.DATA_DIR || path.join(root, '.data'), alg: readConfig().alg });
let failed = 0;
const report = (level, name, detail) => { if (level === 'fail') failed++; console.log(`${level.toUpperCase().padEnd(4)}  ${name}: ${detail}`); };
for (const c of await runChecks({ store })) report(c.level, c.id, c.detail);

// The running lab occupies its own host port; the doctor's port-free check applies to the lab being OFF.
// A running instance of this lab itself is not a clash, so probe only when no spiffe-issuer answers on it.
const port = Number(process.env.PORT) || 7829;
const selfRunning = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok).catch(() => false);
if (!selfRunning) {
  await new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e) => { report('fail', 'port-free', `${port} is not free (${e.code}). Free port 7829 (this app's one allocated port)`); resolve(); });
    s.listen(port, '127.0.0.1', () => s.close(() => { report('pass', 'port-free', `${port} is free`); resolve(); }));
  });
} else {
  report('pass', 'port-free', `${port} is serving this lab (a running instance is not a clash)`);
}
process.exit(failed ? 1 : 0);
