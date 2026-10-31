import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createRunnerHandler } from '../../src/runner/http.ts';
import { composeOverlay, RunManager } from '../../src/runner/manager.ts';
import { agentEgressHosts, loadRunRequest, providerOf, RequestError, resolveRequestDir } from '../../src/runner/request.ts';
import { loadOrCreateToken, tokenMatches } from '../../src/runner/token.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
const GOOD_ID = '20261030-123456-ab12';

const must = <T>(v: T | null | undefined): NonNullable<T> => {
  assert.ok(v != null, 'expected non-null value');
  return v;
};

describe('tokenMatches', () => {
  const t = 'a'.repeat(64);
  it('accepts the right token', () => assert.equal(tokenMatches(t, t), true));
  it('rejects a wrong token of equal length', () => assert.equal(tokenMatches('b'.repeat(64), t), false));
  it('rejects different lengths', () => assert.equal(tokenMatches('short', t), false));
});

describe('loadOrCreateToken', () => {
  it('generates a 0600 file, then reloads it', () => {
    const dir = tmp();
    const first = loadOrCreateToken(dir);
    assert.equal(first.generated, true);
    assert.match(first.token, /^[0-9a-f]{64}$/);
    assert.equal(fs.statSync(path.join(dir, 'RUNNER_TOKEN')).mode & 0o777, 0o600);
    const second = loadOrCreateToken(dir);
    assert.deepEqual(second, { token: first.token, generated: false });
  });
});

describe('resolveRequestDir', () => {
  const data = '/tmp/data';
  it('accepts a well-formed run_id', () => assert.equal(resolveRequestDir(data, GOOD_ID), path.join(data, 'requests', GOOD_ID)));
  it('rejects malformed ids and traversal', () => {
    for (const bad of ['x', '../etc', '20261030-123456', '2026103-123456-ab12', '20261030-123456-AB12', '..%2f..', GOOD_ID.toUpperCase()]) {
      assert.equal(resolveRequestDir(data, bad), null, bad);
    }
  });
});

const mkReqDir = (id: string, files: Record<string, string>): string => {
  const data = tmp();
  const dir = path.join(data, 'requests', id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
};
const REQ = (id = GOOD_ID, model = 'stub//run-input/stub/script.json') => JSON.stringify({ run_id: id, model });
const SPEC = JSON.stringify({ name: 't', start_url: 'http://app.test', goal: 'g' });

describe('loadRunRequest', () => {
  it('loads a valid request', () => {
    const dir = mkReqDir(GOOD_ID, { 'request.json': REQ(), 'spec.json': SPEC });
    assert.deepEqual(loadRunRequest(dir, GOOD_ID), { runId: GOOD_ID, model: 'stub//run-input/stub/script.json', provider: 'stub' });
  });
  it('rejects a missing request.json', () => {
    const dir = mkReqDir(GOOD_ID, { 'spec.json': SPEC });
    assert.throws(() => loadRunRequest(dir, GOOD_ID), RequestError);
  });
  it('rejects an invalid spec', () => {
    const dir = mkReqDir(GOOD_ID, { 'request.json': REQ(), 'spec.json': '{"name":1}' });
    assert.throws(() => loadRunRequest(dir, GOOD_ID), /invalid spec\.json/);
  });
  it('rejects an unknown provider', () => {
    const dir = mkReqDir(GOOD_ID, { 'request.json': REQ(GOOD_ID, 'ollama/llama'), 'spec.json': SPEC });
    assert.throws(() => loadRunRequest(dir, GOOD_ID), /unknown model provider/);
  });
  it('rejects a run_id mismatch', () => {
    const dir = mkReqDir(GOOD_ID, { 'request.json': REQ('20261030-123456-cdef'), 'spec.json': SPEC });
    assert.throws(() => loadRunRequest(dir, GOOD_ID), /does not match/);
  });
});

describe('provider/egress mapping', () => {
  it('maps providers', () => {
    assert.equal(providerOf('anthropic/claude'), 'anthropic');
    assert.equal(providerOf('stub//tests/x.json'), 'stub');
    assert.equal(providerOf('bogus'), null);
    assert.equal(providerOf('evil/x'), null);
    assert.equal(agentEgressHosts('anthropic'), 'api.anthropic.com');
    assert.equal(agentEgressHosts('stub'), 'stub.invalid');
  });
});

describe('composeOverlay', () => {
  it('mounts the request dir and spec for proxy + control dir for orchestrator', () => {
    const yml = composeOverlay('/data/requests/x');
    assert.ok(yml.includes('"/data/requests/x:/run-input:ro"'));
    assert.ok(yml.includes('"/data/requests/x/control:/control:ro"'));
    assert.ok(yml.includes('"/data/requests/x/spec.json:/run-input/spec.json:ro"'));
    assert.ok(yml.includes('CONTROL_DIR: /control'));
  });
});

describe('runner http handler', () => {
  const dataDir = tmp();
  const token = 'f'.repeat(64);
  const calls: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  let releaseWait: ((v: { code: number; out: string }) => void) | null = null;
  const exec = async (args: string[], env: NodeJS.ProcessEnv) => {
    calls.push(args);
    envs.push(env);
    if (args[0] === 'wait') return new Promise<{ code: number; out: string }>((r) => (releaseWait = r));
    if (args.includes('ps')) return { code: 0, out: 'cid123\n' };
    return { code: 0, out: '' };
  };
  const manager = new RunManager({
    root: tmp(),
    dataDir,
    maxConcurrent: 1,
    extraComposeFiles: [],
    env: { PATH: '/usr/bin' },
    exec,
    cancelGraceMs: 40,
  });
  const server = http.createServer((req, res) => {
    createRunnerHandler({ token, dataDir, manager })(req, res).catch((e) => res.end(String(e)));
  });
  let base = '';
  const req = async (method: string, p: string, opts: { token?: string | null; body?: unknown } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? token}`;
    const r = await fetch(`${base}${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    return { code: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null };
  };

  it('starts on an ephemeral port', async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  it('401 without/with a wrong token', async () => {
    assert.equal((await req('GET', '/health', { token: null })).code, 401);
    assert.equal((await req('GET', '/health', { token: 'x'.repeat(64) })).code, 401);
    assert.equal((await req('GET', '/health')).code, 200);
  });

  it('400 on malformed run_id / traversal / missing dir', async () => {
    for (const id of ['bad', '../escape', '20261030-123456']) {
      assert.equal((await req('POST', '/runs', { body: { run_id: id } })).code, 400, id);
    }
    assert.equal((await req('GET', `/runs/${encodeURIComponent('..%2f..')}`)).code, 400);
    assert.equal((await req('POST', '/runs', { body: { run_id: GOOD_ID } })).code, 400); // no request dir
    assert.equal((await req('GET', '/runs/20261030-123456-ffff')).code, 404);
  });

  it('enqueues, reports state, cancels a running run', async () => {
    const dir = path.join(dataDir, 'requests', GOOD_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'request.json'), REQ());
    fs.writeFileSync(path.join(dir, 'spec.json'), SPEC);
    const r = await req('POST', '/runs', { body: { run_id: GOOD_ID } });
    assert.equal(r.code, 202);
    for (let i = 0; i < 100 && (await req('GET', `/runs/${GOOD_ID}`)).body?.state !== 'running'; i++) {
      await new Promise((r2) => setTimeout(r2, 20));
    }
    const st = await req('GET', `/runs/${GOOD_ID}`);
    assert.equal(st.body?.state, 'running');
    // execFile env carries the fixed §16.1 launch variables
    const upEnv = envs[calls.findIndex((c) => c.includes('up'))];
    assert.equal(upEnv.RUN_ID, GOOD_ID);
    assert.equal(upEnv.TEST_FILE, '/run-input/spec.json');
    assert.equal(upEnv.AGENT_MODEL, 'stub//run-input/stub/script.json');
    assert.equal(upEnv.AGENT_EGRESS_HOSTS, 'stub.invalid');
    assert.ok(fs.existsSync(path.join(dir, 'compose.run.yml')));
    assert.ok(fs.existsSync(path.join(dir, 'control')));

    const c = await req('POST', `/runs/${GOOD_ID}/cancel`);
    assert.equal(c.code, 200);
    assert.ok(fs.existsSync(path.join(dir, 'control', 'cancel')));
    must(releaseWait)({ code: 0, out: '4\n' });
    for (let i = 0; i < 100; i++) {
      const s = (await req('GET', `/runs/${GOOD_ID}`)).body;
      if (s?.state === 'cancelled') {
        assert.equal(s.exit_code, 4);
        return;
      }
      await new Promise((r2) => setTimeout(r2, 20));
    }
    assert.fail('run never reached cancelled');
  });
});
