import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunnerHandler } from './http.ts';
import { RunManager } from './manager.ts';
import { loadOrCreateToken } from './token.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bind = process.env.RUNNER_BIND ?? '127.0.0.1:7071';
const host = bind.slice(0, bind.lastIndexOf(':'));
const port = Number(bind.slice(bind.lastIndexOf(':') + 1));
const dataDir = process.env.RUNNER_DATA_DIR ?? path.join(ROOT, 'data');
const secretsDir = process.env.SECRETS_DIR ?? path.join(ROOT, 'secrets');
const maxConcurrent = Math.max(1, Number(process.env.MAX_CONCURRENT_RUNS ?? 2) || 2);
const extraComposeFiles = (process.env.COMPOSE_OVERLAYS ?? '') // same convention as run-test.sh
  .split(/\s+/)
  .filter(Boolean);
const cancelGraceMs = Number(process.env.RUNNER_CANCEL_GRACE_MS ?? 30_000) || 30_000;

const { token, generated } = loadOrCreateToken(secretsDir);
if (generated) {
  console.log(
    `runner: generated a new RUNNER_TOKEN in ${path.join(secretsDir, 'RUNNER_TOKEN')} (mode 0600) — give that file to the ui container`,
  );
}

const manager = new RunManager({
  root: ROOT,
  dataDir,
  maxConcurrent,
  extraComposeFiles,
  env: process.env,
  cancelGraceMs,
});

const handler = createRunnerHandler({ token, dataDir, manager });
const server = http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  });
});

server.listen(port, host, () => {
  const addr = server.address();
  const actual = typeof addr === 'object' && addr ? addr.port : port;
  console.log(`RUNNER_LISTENING http://${host}:${actual} (data=${dataDir}, max=${maxConcurrent})`);
});

let stopping = false;
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`runner: ${signal} received — finishing or tearing down in-flight runs`);
  server.close();
  manager
    .shutdown()
    .catch(() => {})
    .finally(() => process.exit(0));
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
