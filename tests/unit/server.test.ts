import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { RUN_ID_RE } from '../../src/runner/request.ts';
import { createApiHandler, type RunnerClient } from '../../src/server/api.ts';
import { buildSpec, FormError, newRunId, resolveModel, sanitizeFilename, stubScriptText } from '../../src/server/form.ts';
import { ARTIFACT_CSP, hostAllowed, mutationGuard, originAllowed, resolveUnder } from '../../src/server/guards.ts';
import { parseMultipart } from '../../src/server/multipart.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-'));

describe('sanitizeFilename', () => {
  it('keeps safe names, strips paths, rejects unusable ones', () => {
    assert.equal(sanitizeFilename('hero.png'), 'hero.png');
    assert.equal(sanitizeFilename('../etc/passwd'), 'passwd');
    assert.equal(sanitizeFilename('a\\b.png'), 'b.png');
    assert.equal(sanitizeFilename('my file (1).png'), 'my_file__1_.png');
    assert.equal(sanitizeFilename('..'), null);
    assert.equal(sanitizeFilename('...'), null);
    assert.equal(sanitizeFilename('/'), null);
  });
});

describe('newRunId', () => {
  it('matches the §16.1 run_id shape', () => assert.match(newRunId(), RUN_ID_RE));
});

describe('buildSpec (§16.2 form → spec.json)', () => {
  const base = { instructions: 'do the thing', start_url: 'http://app.test/admin', model: 'stub' };
  it('fills defaults: name, title, allowed_origins=[origin]', () => {
    const spec = buildSpec({ ...base, title: 'My run' });
    assert.equal(spec.name, 'My run');
    assert.equal(spec.title, 'My run');
    assert.equal(spec.goal, 'do the thing');
    assert.deepEqual(spec.allowed_origins, ['http://app.test']);
  });
  it('falls back to name=run and honours explicit origins/hosts/budgets', () => {
    const spec = buildSpec({
      ...base,
      allowed_origins: ['http://app.test', 'http://other.test'],
      allowed_hosts: ['cdn.app.test:443'],
      budgets: { max_steps: 12, timeout_s: 90, max_model_tokens: 5000 },
      review_plan: true,
      approval_timeout_s: 60,
    });
    assert.equal(spec.name, 'run');
    assert.deepEqual(spec.allowed_origins, ['http://app.test', 'http://other.test']);
    assert.deepEqual(spec.allowed_hosts, ['cdn.app.test:443']);
    assert.equal(spec.max_steps, 12);
    assert.equal(spec.timeout_s, 90);
    assert.equal(spec.review_plan, true);
    assert.equal(spec.approval_timeout_s, 60);
  });
  it('maps credentials to secret bindings on the start origin', () => {
    const spec = buildSpec({
      ...base,
      credentials: [
        { name: 'TEST_USER_EMAIL', input_types: ['email', 'text'] },
        { name: 'TEST_USER_PASSWORD', input_types: ['password'], origins: ['http://other.test'] },
      ],
    });
    assert.deepEqual(spec.secrets, {
      TEST_USER_EMAIL: { origins: ['http://app.test'], input_types: ['email', 'text'] },
      TEST_USER_PASSWORD: { origins: ['http://other.test'], input_types: ['password'] },
    });
  });
  it('rejects bad input', () => {
    assert.throws(() => buildSpec({ ...base, instructions: '  ' }), FormError);
    assert.throws(() => buildSpec({ ...base, start_url: 'not a url' }), FormError);
    assert.throws(() => buildSpec({ ...base, start_url: 'file:///etc/passwd' }), FormError);
    assert.throws(() => buildSpec({ ...base, credentials: [{ name: 'bad-name!', input_types: ['text'] }] }), FormError);
    assert.throws(() => buildSpec({ ...base, credentials: [{ name: 'X', input_types: [] }] }), FormError);
    assert.throws(() => buildSpec({ ...base, assets: ['../evil.png'] }), FormError);
    assert.throws(() => buildSpec({ ...base, allowed_hosts: ['bad host!'] }), FormError);
  });
});

describe('resolveModel / stubScriptText', () => {
  it('resolves providers', () => {
    assert.equal(resolveModel({ model: 'stub', instructions: 'x', start_url: 'http://a' }), 'stub//run-input/stub/script.json');
    assert.equal(resolveModel({ model: 'stub/blog', instructions: 'x', start_url: 'http://a' }), 'stub//run-input/stub/script.json');
    assert.equal(
      resolveModel({ model: 'anthropic/claude-opus-5-5', instructions: 'x', start_url: 'http://a' }),
      'anthropic/claude-opus-5-5',
    );
    assert.throws(() => resolveModel({ model: 'ollama/x', instructions: 'x', start_url: 'http://a' }), FormError);
    assert.throws(() => resolveModel({ model: '', instructions: 'x', start_url: 'http://a' }), FormError);
  });
  it('writes a default stub script, honours a supplied one, ignores real providers', () => {
    assert.match(stubScriptText({ model: 'stub', instructions: 'x', start_url: 'http://a' }) ?? '', /"kind": ?"done"/);
    assert.equal(stubScriptText({ model: 'stub', instructions: 'x', start_url: 'http://a', stub_script: '{"a":1}' }), '{"a":1}\n');
    assert.equal(stubScriptText({ model: 'anthropic/x', instructions: 'x', start_url: 'http://a' }), null);
    assert.throws(() => stubScriptText({ model: 'stub', instructions: 'x', start_url: 'http://a', stub_script: 'not json' }), FormError);
  });
});

describe('parseMultipart', () => {
  const limits = { maxFiles: 2, maxFileBytes: 10 };
  const mp = (parts: { name: string; filename?: string; value: string }[], boundary = 'X') => {
    const body = Buffer.concat(
      parts.flatMap((p) => [
        Buffer.from(
          `--${boundary}\r\ncontent-disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ''}\r\n\r\n${p.value}\r\n`,
        ),
      ]),
    );
    return Buffer.concat([body, Buffer.from(`--${boundary}--\r\n`)]);
  };
  it('parses fields and files', () => {
    const r = parseMultipart(
      mp([
        { name: 'title', value: 't' },
        { name: 'assets', filename: 'a/b c.png', value: 'PNG' },
      ]),
      'multipart/form-data; boundary=X',
      limits,
    );
    assert.equal(r.fields.title, 't');
    assert.equal(r.files.length, 1);
    assert.equal(r.files[0].filename, 'b_c.png');
    assert.equal(r.files[0].data.toString(), 'PNG');
  });
  it('enforces file count and size limits', () => {
    const many = mp([
      { name: 'a', filename: '1', value: 'x' },
      { name: 'b', filename: '2', value: 'x' },
      { name: 'c', filename: '3', value: 'x' },
    ]);
    assert.throws(() => parseMultipart(many, 'multipart/form-data; boundary=X', limits), /too many files/);
    const big = mp([{ name: 'a', filename: 'big', value: 'x'.repeat(11) }]);
    assert.throws(() => parseMultipart(big, 'multipart/form-data; boundary=X', limits), /exceeds/);
  });
  it('rejects a missing boundary', () => assert.throws(() => parseMultipart(Buffer.from('x'), 'multipart/form-data', limits), /boundary/));
});

describe('guards (§16.2)', () => {
  const allowed = ['localhost:7070', '127.0.0.1:7070'];
  it('hostAllowed', () => {
    assert.equal(hostAllowed('127.0.0.1:7070', allowed), true);
    assert.equal(hostAllowed('localhost:7070', allowed), true);
    assert.equal(hostAllowed('evil.test', allowed), false);
    assert.equal(hostAllowed('127.0.0.1:7070.evil.test', allowed), false);
    assert.equal(hostAllowed(undefined, allowed), false);
  });
  it('originAllowed', () => {
    assert.equal(originAllowed('http://127.0.0.1:7070', allowed), true);
    assert.equal(originAllowed('http://localhost:7070', allowed), true);
    assert.equal(originAllowed('http://evil.test', allowed), false);
    assert.equal(originAllowed('garbage', allowed), false);
    assert.equal(originAllowed(undefined, allowed), false);
  });
  it('mutationGuard: Origin required + json/multipart CT on mutations', () => {
    const h = (origin: string | undefined, ct?: string) => ({ origin, 'content-type': ct });
    assert.equal(mutationGuard('POST', h('http://127.0.0.1:7070', 'application/json'), allowed), 'ok');
    assert.equal(mutationGuard('POST', h('http://localhost:7070', 'multipart/form-data; boundary=x'), allowed), 'ok');
    assert.equal(mutationGuard('POST', h(undefined, 'application/json'), allowed), 'bad-origin');
    assert.equal(mutationGuard('POST', h('http://evil.test', 'application/json'), allowed), 'bad-origin');
    assert.equal(mutationGuard('POST', h('http://127.0.0.1:7070', 'text/plain'), allowed), 'bad-content-type');
    assert.equal(mutationGuard('POST', h('http://127.0.0.1:7070'), allowed), 'bad-content-type');
    assert.equal(mutationGuard('GET', {}, allowed), 'ok');
  });
  it('resolveUnder blocks traversal', () => {
    assert.equal(resolveUnder('/a', ['run', 'x.png']), path.join('/a', 'run', 'x.png'));
    assert.equal(resolveUnder('/a', ['..', 'etc']), null);
    assert.equal(resolveUnder('/a', ['%2e%2e', 'etc']), null);
    assert.equal(resolveUnder('/a', ['run', '..', 'x']), null);
    assert.equal(resolveUnder('/a', ['a/b']), null);
    assert.equal(resolveUnder('/a', ['']), null);
  });
});

describe('api handler over a real http server', () => {
  const dataDir = tmp();
  const artifactsDir = tmp();
  const secretsDir = tmp();
  const uiDist = tmp();
  fs.writeFileSync(path.join(secretsDir, 'ANTHROPIC_API_KEY'), 'x');
  fs.writeFileSync(path.join(secretsDir, 'RUNNER_TOKEN'), 'x');
  fs.writeFileSync(path.join(secretsDir, 'TEST_USER_PASSWORD'), 'x');
  const runnerCalls: { method: string; id: string }[] = [];
  const runner: RunnerClient = {
    create: async (id) => {
      runnerCalls.push({ method: 'create', id });
      return { state: 'queued' };
    },
    cancel: async (id) => {
      runnerCalls.push({ method: 'cancel', id });
      return { state: 'cancelled' };
    },
    status: async () => ({ state: 'running' }),
  };
  let port = 0;
  const handler = createApiHandler({
    dataDir,
    artifactsDir,
    secretsDir,
    uiDist,
    allowedHosts: () => [`localhost:${port}`, `127.0.0.1:${port}`],
    runner,
  });
  const server = http.createServer((req, res) => handler(req, res).catch((e) => res.end(String(e))));

  const raw = (method: string, p: string, headers: Record<string, string>, body?: string | Buffer) =>
    new Promise<{ code: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ code: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      r.on('error', reject);
      if (body !== undefined) r.write(body);
      r.end();
    });
  const api = (method: string, p: string, opts: { host?: string; origin?: string | null; ct?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${port}` };
    if (opts.origin !== null) headers.origin = opts.origin ?? `http://127.0.0.1:${port}`;
    if (opts.ct) headers['content-type'] = opts.ct;
    const body =
      typeof opts.body === 'string' || Buffer.isBuffer(opts.body)
        ? opts.body
        : opts.body === undefined
          ? undefined
          : JSON.stringify(opts.body);
    if (body !== undefined && !opts.ct) headers['content-type'] = 'application/json';
    return raw(method, p, headers, body);
  };

  it('starts on an ephemeral port', async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  it('rejects a wrong Host with 421', async () => {
    assert.equal((await api('GET', '/api/runs', { host: 'evil.test:1' })).code, 421);
    assert.equal((await api('GET', '/api/runs')).code, 200);
  });

  it('rejects bad Origin / missing Origin / text/plain mutations with 403', async () => {
    const form = { title: 'x', instructions: 'i', start_url: 'http://app.test', model: 'stub' };
    assert.equal((await api('POST', '/api/runs', { origin: 'http://evil.test', body: form })).code, 403);
    assert.equal((await api('POST', '/api/runs', { origin: null, body: form })).code, 403);
    assert.equal((await api('POST', '/api/runs', { ct: 'text/plain', body: 'instructions=x' })).code, 403);
  });

  it('creates a run from JSON: request dir + spec + runner call', async () => {
    const r = await api('POST', '/api/runs', {
      body: {
        title: 'Login check',
        instructions: 'log in',
        start_url: 'http://app.test/login',
        model: 'stub',
        credentials: [{ name: 'TEST_USER_PASSWORD', input_types: ['password'] }],
      },
    });
    assert.equal(r.code, 201);
    const id = (JSON.parse(r.body) as { run_id: string }).run_id;
    assert.match(id, RUN_ID_RE);
    const spec = JSON.parse(fs.readFileSync(path.join(dataDir, 'requests', id, 'spec.json'), 'utf8'));
    assert.equal(spec.goal, 'log in');
    assert.deepEqual(spec.allowed_origins, ['http://app.test']);
    assert.deepEqual(spec.secrets.TEST_USER_PASSWORD, { origins: ['http://app.test'], input_types: ['password'] });
    const reqj = JSON.parse(fs.readFileSync(path.join(dataDir, 'requests', id, 'request.json'), 'utf8'));
    assert.equal(reqj.model, 'stub//run-input/stub/script.json');
    assert.ok(fs.existsSync(path.join(dataDir, 'requests', id, 'stub', 'script.json')));
    assert.deepEqual(runnerCalls.at(-1), { method: 'create', id });
    const detail = await api('GET', `/api/runs/${id}`);
    assert.equal(detail.code, 200);
    assert.equal((JSON.parse(detail.body) as { runner_state: string }).runner_state, 'running');
  });

  it('creates a run from multipart with an uploaded asset', async () => {
    const boundary = 'TESTBOUNDARY';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="instructions"\r\n\r\nupload a picture\r\n` +
          `--${boundary}\r\ncontent-disposition: form-data; name="start_url"\r\n\r\nhttp://app.test\r\n` +
          `--${boundary}\r\ncontent-disposition: form-data; name="model"\r\n\r\nstub\r\n` +
          `--${boundary}\r\ncontent-disposition: form-data; name="assets"; filename="../hero pic.png"\r\ncontent-type: image/png\r\n\r\nPNGDATA\r\n` +
          `--${boundary}--\r\n`,
      ),
    ]);
    const r = await api('POST', '/api/runs', { ct: `multipart/form-data; boundary=${boundary}`, body });
    assert.equal(r.code, 201);
    const id = (JSON.parse(r.body) as { run_id: string }).run_id;
    assert.equal(fs.readFileSync(path.join(dataDir, 'requests', id, 'assets', 'hero_pic.png'), 'utf8'), 'PNGDATA');
    const spec = JSON.parse(fs.readFileSync(path.join(dataDir, 'requests', id, 'spec.json'), 'utf8'));
    assert.deepEqual(spec.assets, ['hero_pic.png']);
  });

  it('approve/reject write control/approval.json; cancel and rerun go to the runner', async () => {
    const id = fs.readdirSync(path.join(dataDir, 'requests'))[0];
    const plan = { title: 'p', steps: [{ id: 'p1', intent: 'i', expected: 'e' }], criteria: [{ id: 'c1', description: 'd' }] };
    const ra = await api('POST', `/api/runs/${id}/approve`, { body: { plan } });
    assert.equal(ra.code, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'requests', id, 'control', 'approval.json'), 'utf8')), {
      decision: 'approve',
      plan,
    });
    const badPlan = await api('POST', `/api/runs/${id}/approve`, { body: { plan: { title: '' } } });
    assert.equal(badPlan.code, 400);
    const rr = await api('POST', `/api/runs/${id}/reject`, { body: {} });
    assert.equal(rr.code, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'requests', id, 'control', 'approval.json'), 'utf8')).decision, 'reject');
    const rc = await api('POST', `/api/runs/${id}/cancel`, { body: {} });
    assert.equal(rc.code, 200);
    assert.deepEqual(runnerCalls.at(-1), { method: 'cancel', id });
    const rerun = await api('POST', `/api/runs/${id}/rerun`, { body: {} });
    assert.equal(rerun.code, 201);
    const nid = (JSON.parse(rerun.body) as { run_id: string }).run_id;
    assert.notEqual(nid, id);
    assert.ok(fs.existsSync(path.join(dataDir, 'requests', nid, 'request.json')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'requests', nid, 'request.json'), 'utf8')).run_id, nid);
    assert.equal(fs.readdirSync(path.join(dataDir, 'requests', nid, 'control')).length, 0); // fresh control dir
    const missing = await api('POST', '/api/runs/20261030-123456-ffff/cancel', { body: {} });
    assert.equal(missing.code, 404);
  });

  it('models and secrets list only names', async () => {
    const models = JSON.parse((await api('GET', '/api/models')).body) as { models: string[] };
    assert.deepEqual(models.models, ['anthropic/claude-opus-5-5', 'stub']);
    const secrets = JSON.parse((await api('GET', '/api/secrets')).body) as { secrets: string[] };
    assert.deepEqual(secrets.secrets, ['TEST_USER_PASSWORD']);
  });

  it('serves artifacts with CSP + nosniff and blocks traversal', async () => {
    const id = fs.readdirSync(path.join(dataDir, 'requests'))[0];
    fs.mkdirSync(path.join(artifactsDir, id), { recursive: true });
    fs.writeFileSync(path.join(artifactsDir, id, 'run.json'), '{"status":"PASSED"}');
    fs.writeFileSync(path.join(artifactsDir, id, 'final.mp4'), 'mp4');
    fs.writeFileSync(path.join(artifactsDir, id, 'chapters.vtt'), 'WEBVTT');
    const r1 = await api('GET', `/artifacts/${id}/run.json`);
    assert.equal(r1.code, 200);
    assert.equal(r1.headers['content-type'], 'application/json');
    assert.equal(r1.headers['content-security-policy'], ARTIFACT_CSP);
    assert.equal(r1.headers['x-content-type-options'], 'nosniff');
    assert.equal((await api('GET', `/artifacts/${id}/final.mp4`)).headers['content-type'], 'video/mp4');
    assert.equal((await api('GET', `/artifacts/${id}/chapters.vtt`)).headers['content-type'], 'text/vtt');
    assert.equal((await api('GET', `/artifacts/${id}/../../secrets/x`)).code, 400);
    assert.equal((await api('GET', `/artifacts/${id}/%2e%2e/x`)).code, 400);
    assert.equal((await api('GET', `/artifacts/${id}/%2e%2e%2fsecrets%2fx`)).code, 400);
    assert.equal((await api('GET', `/artifacts/${id}/nope.png`)).code, 404);
  });

  it('streams events.jsonl over SSE and ends on run.json', async () => {
    const id = fs.readdirSync(path.join(dataDir, 'requests'))[0];
    const art = path.join(artifactsDir, id);
    fs.mkdirSync(art, { recursive: true });
    fs.writeFileSync(path.join(art, 'events.jsonl'), '{"seq":0,"type":"RUN_START"}\n{"seq":1,"type":"RUN_END"}\n');
    fs.writeFileSync(path.join(art, 'status.json'), '{"phase":"done"}');
    fs.writeFileSync(path.join(art, 'run.json'), '{"status":"PASSED"}');
    const body = await new Promise<string>((resolve, reject) => {
      http
        .request({ host: '127.0.0.1', port, path: `/api/runs/${id}/events`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
          assert.equal(res.headers['content-type'], 'text/event-stream');
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString()));
        })
        .on('error', reject)
        .end();
    });
    assert.match(body, /data: \{"seq":0,"type":"RUN_START"\}/);
    assert.match(body, /event: status/);
    assert.match(body, /event: done/);
  });

  it('GET / falls back to a JSON health page when ui/dist has no index.html', async () => {
    const r = await api('GET', '/');
    assert.equal(r.code, 200);
    assert.match(r.body, /not built/);
  });
});
