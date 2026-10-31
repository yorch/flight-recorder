// Minimal stand-in for src/runner/index.ts: accepts the runner API so control-plane
// tests never touch Docker. Tracks run states in memory only.
import http from 'node:http';

const bind = process.env.FAKE_RUNNER_BIND ?? '127.0.0.1:0';
const host = bind.slice(0, bind.lastIndexOf(':'));
const port = Number(bind.slice(bind.lastIndexOf(':') + 1));
const runs = new Map();

const server = http.createServer((req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://fake');
    if (url.pathname === '/health') return json(200, { ok: true });
    if (url.pathname === '/runs' && req.method === 'POST') {
      const { run_id } = JSON.parse(body || '{}');
      runs.set(run_id, { state: 'queued' });
      console.log(`FAKE_CREATE ${run_id}`);
      return json(202, { run_id, state: 'queued' });
    }
    const m = /^\/runs\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (!m) return json(404, { error: 'not found' });
    const run = runs.get(m[1]);
    if (!run) return json(404, { error: 'unknown run' });
    if (m[2] === '/cancel' && req.method === 'POST') {
      run.state = 'cancelled';
      console.log(`FAKE_CANCEL ${m[1]}`);
      return json(200, { state: 'cancelled' });
    }
    if (req.method === 'GET') return json(200, run);
    return json(405, { error: 'method' });
  });
});

server.listen(port, host, () => {
  console.log(`FAKE_RUNNER_LISTENING http://${host}:${server.address().port}`);
});
