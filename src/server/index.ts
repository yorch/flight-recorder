import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiHandler, httpRunnerClient } from './api.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT ?? 7070) || 0;
const BIND = process.env.BIND ?? '127.0.0.1';
const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const artifactsDir = process.env.ARTIFACTS_DIR ?? path.join(ROOT, 'artifacts');
const secretsDir = process.env.SECRETS_DIR ?? (fs.existsSync('/run/secrets') ? '/run/secrets' : path.join(ROOT, 'secrets'));
const uiDist = process.env.UI_DIST ?? path.join(ROOT, 'ui', 'dist');
const runnerUrl = process.env.RUNNER_URL ?? 'http://127.0.0.1:7071';

let runnerToken = '';
try {
  runnerToken = fs.readFileSync(path.join(secretsDir, 'RUNNER_TOKEN'), 'utf8').trim();
} catch {
  console.log(`server: no RUNNER_TOKEN in ${secretsDir} — calls to the runner will fail`);
}
if (!runnerToken) console.log('server: empty RUNNER_TOKEN — calls to the runner will fail');

let actualPort = PORT;
const extraHosts = (process.env.UI_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);
const handler = createApiHandler({
  dataDir,
  artifactsDir,
  secretsDir,
  uiDist,
  allowedHosts: () => [`localhost:${actualPort}`, `127.0.0.1:${actualPort}`, `[::1]:${actualPort}`, ...extraHosts],
  runner: httpRunnerClient(runnerUrl, runnerToken),
});

const server = http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  });
});

server.listen(PORT, BIND, () => {
  const addr = server.address();
  actualPort = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(`SERVER_LISTENING http://${BIND}:${actualPort} (data=${dataDir}, runner=${runnerUrl})`);
});
