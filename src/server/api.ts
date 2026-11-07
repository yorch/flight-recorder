import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { parsePlan } from '../agent/plan.ts';
import { networkEntries } from '../network.ts';
import { RUN_ID_RE } from '../runner/request.ts';
import { buildSpec, FormError, newRunId, type RunForm, resolveModel, stubScriptText } from './form.ts';
import { ARTIFACT_CSP, contentTypeFor, hostAllowed, mutationGuard, resolveUnder } from './guards.ts';
import { MultipartError, parseMultipart } from './multipart.ts';

export interface RunnerClient {
  create(runId: string): Promise<{ state: string }>;
  cancel(runId: string): Promise<{ state: string }>;
  status(runId: string): Promise<{ state: string; exit_code?: number }>;
}

export function httpRunnerClient(baseUrl: string, token: string, timeoutMs = 5000): RunnerClient {
  const call = async (method: string, p: string, body?: unknown): Promise<{ state: string; exit_code?: number }> => {
    const res = await fetch(`${baseUrl}${p}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as { state?: string; exit_code?: number; error?: string };
    if (!res.ok) throw new Error(json.error ?? `runner ${method} ${p} -> ${res.status}`);
    return { state: json.state ?? 'unknown', exit_code: json.exit_code };
  };
  return {
    create: (runId) => call('POST', '/runs', { run_id: runId }),
    cancel: (runId) => call('POST', `/runs/${runId}/cancel`),
    status: (runId) => call('GET', `/runs/${runId}`),
  };
}

export interface ServerDeps {
  dataDir: string;
  artifactsDir: string;
  secretsDir: string;
  uiDist: string; // may not exist (SPA is a later phase)
  allowedHosts: () => string[];
  runner: RunnerClient;
}

const JSON_CAP = 1024 * 1024; // §16.2: 1 MB JSON bodies
const MULTIPART_CAP = 20 * 25 * 1024 * 1024 + 128 * 1024; // 20 files × 25 MB + framing slack
const IGNORED_SECRET_FILES = new Set(['RUNNER_TOKEN', 'UI_TOKEN', '.gitkeep']);

const readBody = (req: IncomingMessage, cap: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > cap) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

class HttpError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const json = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
};

const readJsonFile = (file: string): Json | undefined => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
  } catch {
    return undefined;
  }
};

const readText = (file: string): string | null => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

const readLines = (file: string): unknown[] => {
  const out: unknown[] = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* partially written trailing line */
      }
    }
  } catch {
    /* file absent */
  }
  return out;
};

type TimelineEventLike = {
  type?: string;
  t_ms?: number;
  step_id?: string;
  action?: string;
  label?: string;
  plan_step?: string | null;
  status?: string;
  error?: string;
};

/** Files that actually exist in the run's artifact dir (top level, logs/, agent/), with sizes. */
export function listArtifacts(art: string): { file: string; bytes: number }[] {
  const out: { file: string; bytes: number }[] = [];
  for (const sub of ['', 'logs', 'agent']) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(art, sub));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const st = fs.statSync(path.join(art, sub, name), { throwIfNoEntry: false });
      if (st?.isFile()) out.push({ file: sub ? `${sub}/${name}` : name, bytes: st.size });
    }
  }
  return out;
}

/**
 * §16.3 live progress: everything the harness currently knows about a run,
 * derived from status.json, plan.json, events.jsonl, agent/transcript.jsonl and
 * the screenshots directory. The detail API embeds it and the SSE stream emits
 * it as `progress` events whenever it changes.
 */
const computeProgress = (art: string): Record<string, unknown> => {
  const status = (readJsonFile(path.join(art, 'status.json')) ?? {}) as {
    phase?: string;
    plan_step?: string | null;
    step_id?: string | null;
  };
  const plan = readJsonFile(path.join(art, 'plan.json')) as { steps?: { id: string }[] } | undefined;

  const starts = new Map<string, { kind: string; label: string; plan_step: string | null }>();
  const ends = new Map<string, { status?: string; error?: string }>();
  let t0: number | null = null;
  let tEnd: number | null = null;
  let eventCount = 0;
  let planStep: string | null = status.plan_step ?? null;
  let stepId: string | null = status.step_id ?? null;
  for (const raw of readLines(path.join(art, 'events.jsonl'))) {
    const e = raw as TimelineEventLike;
    eventCount += 1;
    if (e.type === 'RUN_START' && typeof e.t_ms === 'number') t0 = e.t_ms;
    if (e.type === 'RUN_END' && typeof e.t_ms === 'number') tEnd = e.t_ms;
    if (e.type === 'ACTION_START' && e.step_id) {
      starts.set(e.step_id, { kind: e.action ?? '?', label: e.label ?? '', plan_step: e.plan_step ?? null });
      if (e.plan_step) planStep = e.plan_step;
      stepId = e.step_id;
    }
    if (e.type === 'ACTION_END' && e.step_id) ends.set(e.step_id, { status: e.status, error: e.error });
  }

  const steps = [...starts.entries()].map(([id, s]) => {
    const end = ends.get(id);
    return {
      step_id: id,
      kind: s.kind,
      label: s.label,
      plan_step: s.plan_step,
      result: end?.status ? end.status.toLowerCase() : 'running',
      ...(end?.error ? { error: end.error } : {}),
    };
  });

  // A step_done ACTION pair carries the plan step's verdict; the plan step that
  // owns the latest ACTION_START is 'running'; the rest stay 'open'.
  const stepVerdict = new Map<string, string>();
  for (const [id, s] of starts) {
    if (s.kind === 'step' && s.plan_step && ends.get(id)?.status) stepVerdict.set(s.plan_step, String(ends.get(id)?.status).toLowerCase());
  }
  const planSteps = (plan?.steps ?? []).map((s) => ({
    id: s.id,
    status: stepVerdict.get(s.id) ?? (s.id === planStep ? 'running' : 'open'),
  }));

  const tokens = { input: 0, output: 0 };
  for (const raw of readLines(path.join(art, 'agent', 'transcript.jsonl'))) {
    const u = (raw as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    tokens.input += u?.input_tokens ?? 0;
    tokens.output += u?.output_tokens ?? 0;
  }

  let latestShot: string | null = null;
  try {
    latestShot =
      fs
        .readdirSync(path.join(art, 'screenshots'))
        .filter((f) => /^[A-Za-z0-9._-]+\.png$/i.test(f))
        .sort()
        .at(-1) ?? null;
  } catch {
    /* no screenshots dir yet */
  }

  const elapsed = t0 === null ? null : Math.max(0, Math.round(((tEnd ?? Date.now()) - t0) / 1000));
  return {
    phase: status.phase ?? null,
    plan_step: planStep,
    step_id: stepId,
    plan_steps: planSteps,
    steps,
    latest_screenshot: latestShot,
    counters: { elapsed_s: elapsed, steps: steps.length, tokens },
    events: eventCount,
  };
};

const atomicWrite = (file: string, text: string): void => {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
};

/** Form fields may arrive as JSON text (multipart) or native values (JSON body). */
const fieldValue = (v: unknown): Json | undefined => {
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return undefined;
    try {
      return JSON.parse(t) as Json;
    } catch {
      return t;
    }
  }
  return v as Json | undefined;
};

const fieldList = (v: unknown): string[] | undefined => {
  const parsed = fieldValue(v);
  if (parsed === undefined) return undefined;
  if (Array.isArray(parsed)) return parsed.map(String);
  if (typeof parsed === 'string')
    return parsed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return undefined;
};

function formFromBody(fields: Record<string, unknown>, assetNames: string[]): RunForm {
  const declared = fieldList(fields.assets) ?? [];
  const budgets = (fieldValue(fields.budgets) ?? {}) as RunForm['budgets'];
  return {
    title: fieldValue(fields.title) as string | undefined,
    instructions: (fieldValue(fields.instructions) ?? '') as string,
    start_url: (fieldValue(fields.start_url) ?? '') as string,
    model: (fieldValue(fields.model) ?? '') as string,
    allowed_origins: fieldList(fields.allowed_origins),
    allowed_hosts: fieldList(fields.allowed_hosts),
    credentials: fieldValue(fields.credentials) as RunForm['credentials'],
    budgets: {
      max_steps: (fieldValue(fields.max_steps) ?? budgets?.max_steps) as number | undefined,
      timeout_s: (fieldValue(fields.timeout_s) ?? budgets?.timeout_s) as number | undefined,
      max_model_tokens: (fieldValue(fields.max_model_tokens) ?? budgets?.max_model_tokens) as number | undefined,
    },
    review_plan: fieldValue(fields.review_plan) === true || fieldValue(fields.review_plan) === 'true',
    approval_timeout_s: fieldValue(fields.approval_timeout_s) as number | undefined,
    network: fieldValue(fields.network) as RunForm['network'],
    assets: [...new Set([...declared, ...assetNames])],
    stub_script: fieldValue(fields.stub_script),
  };
}

async function parseRunForm(req: IncomingMessage): Promise<{ form: RunForm; files: { filename: string; data: Buffer }[] }> {
  const ct = String(req.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (ct === 'multipart/form-data') {
    const body = await readBody(req, MULTIPART_CAP);
    const mp = parseMultipart(body, String(req.headers['content-type']), { maxFiles: 20, maxFileBytes: 25 * 1024 * 1024 });
    return {
      form: formFromBody(
        mp.fields,
        mp.files.map((f) => f.filename),
      ),
      files: mp.files,
    };
  }
  const body = await readBody(req, JSON_CAP);
  try {
    return { form: formFromBody(JSON.parse(body.toString('utf8') || '{}') as Record<string, unknown>, []), files: [] };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new FormError('invalid JSON body');
  }
}

export function createApiHandler(deps: ServerDeps) {
  const reqDir = (id: string) => path.join(deps.dataDir, 'requests', id);
  const artDir = (id: string) => path.join(deps.artifactsDir, id);

  const requireRunDir = (id: string): string => {
    if (!RUN_ID_RE.test(id)) throw new HttpError(400, 'invalid run id');
    const dir = reqDir(id);
    if (!fs.existsSync(path.join(dir, 'request.json'))) throw new HttpError(404, 'unknown run');
    return dir;
  };

  const listRuns = async () => {
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(path.join(deps.dataDir, 'requests')).filter((d) => RUN_ID_RE.test(d));
    } catch {
      /* no data dir yet */
    }
    const rows = await Promise.all(
      ids.map(async (id) => {
        const request = readJsonFile(path.join(reqDir(id), 'request.json')) as
          | { title?: string; model?: string; requested_model?: string; submitted_at?: string; form?: { title?: string } }
          | undefined;
        const status = readJsonFile(path.join(artDir(id), 'status.json')) as { phase?: string } | undefined;
        const run = readJsonFile(path.join(artDir(id), 'run.json')) as
          | {
              status?: string;
              exit_code?: number;
              summary?: string;
              started_at?: string;
              ended_at?: string;
              test?: string;
              steps?: number;
              tokens?: { input?: number; output?: number };
            }
          | undefined;
        const runner = await deps.runner.status(id).catch(() => null);
        return {
          run_id: id,
          title: request?.form?.title ?? request?.title ?? run?.test ?? null,
          model: request?.requested_model ?? request?.model ?? null,
          submitted_at: request?.submitted_at ?? null,
          runner_state: runner?.state ?? null,
          phase: status?.phase ?? null,
          status: run?.status ?? status?.phase ?? runner?.state ?? 'submitted',
          exit_code: run?.exit_code ?? runner?.exit_code ?? null,
          summary: run?.summary ?? null,
          started_at: run?.started_at ?? null,
          ended_at: run?.ended_at ?? null,
          steps: run?.steps ?? null,
          tokens: run?.tokens ?? null,
        };
      }),
    );
    return rows.sort((a, b) => b.run_id.localeCompare(a.run_id));
  };

  const runDetail = async (id: string) => {
    const dir = requireRunDir(id);
    const art = artDir(id);
    const eventsFile = path.join(art, 'events.jsonl');
    let events: { count: number; tail: unknown[] } = { count: 0, tail: [] };
    try {
      const lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean);
      events = { count: lines.length, tail: lines.slice(-5).map((l) => JSON.parse(l)) };
    } catch {
      /* no events yet */
    }
    const runner = await deps.runner.status(id).catch(() => null);
    return {
      run_id: id,
      request: readJsonFile(path.join(dir, 'request.json')) ?? null,
      spec: readJsonFile(path.join(dir, 'spec.json')) ?? null,
      runner_state: runner?.state ?? null,
      status: readJsonFile(path.join(art, 'status.json')) ?? null,
      run: readJsonFile(path.join(art, 'run.json')) ?? null,
      plan: readJsonFile(path.join(art, 'plan.json')) ?? null,
      evaluation: readJsonFile(path.join(art, 'evaluation.json')) ?? null,
      report: readJsonFile(path.join(art, 'report.json')) ?? null,
      events,
      progress: computeProgress(art),
      artifacts: listArtifacts(art),
    };
  };

  const createRun = async (req: IncomingMessage, res: ServerResponse) => {
    const { form, files } = await parseRunForm(req);
    const spec = buildSpec(form); // FormError on invalid input
    const model = resolveModel(form);
    const stubText = stubScriptText(form);
    const id = newRunId();
    const dir = reqDir(id);
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'control'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'stub'), { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(dir, 'assets', f.filename), f.data);
    if (stubText !== null) fs.writeFileSync(path.join(dir, 'stub', 'script.json'), stubText);
    atomicWrite(path.join(dir, 'spec.json'), `${JSON.stringify(spec, null, 2)}\n`);
    atomicWrite(
      path.join(dir, 'request.json'),
      `${JSON.stringify(
        {
          run_id: id,
          model,
          requested_model: form.model,
          submitted_at: new Date().toISOString(),
          form: {
            title: form.title ?? null,
            instructions: form.instructions,
            start_url: form.start_url,
            review_plan: form.review_plan ?? false,
            credentials: (form.credentials ?? []).map((c) => ({ name: c.name, input_types: c.input_types })),
          },
        },
        null,
        2,
      )}\n`,
    );
    try {
      const r = await deps.runner.create(id);
      json(res, 201, { run_id: id, state: r.state });
    } catch (err) {
      throw new HttpError(502, `runner refused the run: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const writeDecision = (id: string, body: unknown, decision: 'approve' | 'reject') => {
    const dir = requireRunDir(id);
    let plan: unknown;
    if (decision === 'approve' && body && typeof body === 'object' && 'plan' in body) {
      plan = parsePlan((body as { plan: unknown }).plan); // throws → 400
    }
    fs.mkdirSync(path.join(dir, 'control'), { recursive: true });
    const payload = plan === undefined ? { decision } : { decision, plan };
    atomicWrite(path.join(dir, 'control', 'approval.json'), JSON.stringify(payload));
  };

  const rerun = async (id: string): Promise<string> => {
    const dir = requireRunDir(id);
    const nid = newRunId();
    const ndir = reqDir(nid);
    for (const sub of ['assets', 'control', 'stub']) fs.mkdirSync(path.join(ndir, sub), { recursive: true });
    for (const sub of ['assets', 'stub']) {
      const from = path.join(dir, sub);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(ndir, sub), { recursive: true });
    }
    fs.copyFileSync(path.join(dir, 'spec.json'), path.join(ndir, 'spec.json'));
    fs.copyFileSync(path.join(dir, 'request.json'), path.join(ndir, 'request.json'));
    const req = readJsonFile(path.join(ndir, 'request.json')) as Record<string, unknown>;
    req.run_id = nid;
    req.submitted_at = new Date().toISOString();
    atomicWrite(path.join(ndir, 'request.json'), `${JSON.stringify(req, null, 2)}\n`);
    await deps.runner.create(nid);
    return nid;
  };

  const serveEvents = (req: IncomingMessage, res: ServerResponse, id: string) => {
    requireRunDir(id);
    const art = artDir(id);
    const eventsFile = path.join(art, 'events.jsonl');
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    });
    res.write('retry: 3000\n\n');
    let offset = 0;
    let lastStatus = '';
    let lastProgress = '';
    let doneSent = false;
    const flush = () => {
      try {
        const size = fs.statSync(eventsFile).size;
        if (size > offset) {
          const fd = fs.openSync(eventsFile, 'r');
          const buf = Buffer.alloc(size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          fs.closeSync(fd);
          const lastNl = buf.lastIndexOf(0x0a);
          if (lastNl >= 0) {
            const complete = buf.subarray(0, lastNl + 1).toString('utf8');
            offset += lastNl + 1;
            for (const line of complete.split('\n')) if (line.trim()) res.write(`data: ${line}\n\n`);
          }
        }
      } catch {
        /* events.jsonl not there yet */
      }
      try {
        const s = fs.readFileSync(path.join(art, 'status.json'), 'utf8');
        if (s !== lastStatus) {
          lastStatus = s;
          res.write(`event: status\ndata: ${s.trim()}\n\n`);
        }
      } catch {
        /* no status yet */
      }
      try {
        const p = JSON.stringify(computeProgress(art));
        if (p !== lastProgress) {
          lastProgress = p;
          res.write(`event: progress\ndata: ${p}\n\n`);
        }
      } catch {
        /* progress not computable yet */
      }
      if (!doneSent && fs.existsSync(path.join(art, 'run.json'))) {
        flushDone(res, art);
        doneSent = true;
        clearInterval(iv);
        res.end();
      }
    };
    const flushDone = (r: ServerResponse, a: string) => {
      try {
        r.write(`event: done\ndata: ${fs.readFileSync(path.join(a, 'run.json'), 'utf8').trim()}\n\n`);
      } catch {
        /* partial write */
      }
    };
    const iv = setInterval(flush, 500);
    req.on('close', () => clearInterval(iv));
    flush();
  };

  const serveArtifact = (req: IncomingMessage, res: ServerResponse, segments: string[]) => {
    const abs = resolveUnder(deps.artifactsDir, segments);
    if (!abs) throw new HttpError(400, 'invalid artifact path');
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      throw new HttpError(404, 'not found');
    }
    if (!st.isFile()) throw new HttpError(404, 'not found');
    const head = {
      'content-type': contentTypeFor(abs),
      'accept-ranges': 'bytes',
      'content-security-policy': ARTIFACT_CSP,
      'x-content-type-options': 'nosniff',
    } as Record<string, string | number>;
    // Single-range bytes support: <video> seeking needs 206 responses (the mp4 moov
    // atom sits at the end of ffmpeg output, so Chrome fetches the tail first).
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim());
    if (m && (m[1] !== '' || m[2] !== '')) {
      const size = st.size;
      let start = 0;
      let end = size - 1;
      if (m[1] === '') {
        start = Math.max(0, size - Number.parseInt(m[2] ?? '0', 10));
      } else {
        start = Number.parseInt(m[1] ?? '0', 10);
        if (m[2] !== '') end = Math.min(Number.parseInt(m[2] ?? '0', 10), size - 1);
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        res.writeHead(416, { ...head, 'content-range': `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      fs.createReadStream(abs, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...head, 'content-length': st.size });
    fs.createReadStream(abs).pipe(res);
  };

  const serveStatic = (res: ServerResponse, pathname: string) => {
    const index = path.join(deps.uiDist, 'index.html');
    if (!fs.existsSync(index)) {
      return json(res, 200, { ok: true, service: 'flight-recorder-ui', ui: 'not built' });
    }
    const rel = pathname === '/' ? ['index.html'] : pathname.split('/').filter(Boolean);
    const abs = resolveUnder(deps.uiDist, rel);
    const file = abs && fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : index; // SPA fallback
    res.writeHead(200, { 'content-type': contentTypeFor(file), 'x-content-type-options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  };

  const secretNames = (): string[] => {
    try {
      return fs
        .readdirSync(deps.secretsDir)
        .filter(
          (f) =>
            !IGNORED_SECRET_FILES.has(f) &&
            !f.startsWith('.') &&
            !f.endsWith('_API_KEY') &&
            fs.statSync(path.join(deps.secretsDir, f)).isFile(),
        )
        .sort();
    } catch {
      return [];
    }
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const allowed = deps.allowedHosts();
      if (!hostAllowed(req.headers.host, allowed))
        return json(res, 421, { error: 'misdirected request', hint: `Host must be one of: ${allowed.join(', ')}` });
      const guard = mutationGuard(req.method, req.headers, allowed);
      if (guard !== 'ok') return json(res, 403, { error: guard === 'bad-origin' ? 'origin not allowed' : 'content type not allowed' });
      if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

      const url = new URL(req.url ?? '/', 'http://ui');
      const p = url.pathname;

      if (p === '/api/runs') {
        if (req.method === 'GET') return json(res, 200, { runs: await listRuns() });
        return await createRun(req, res);
      }
      if (p === '/api/models' && req.method === 'GET') {
        const has = (f: string) => fs.existsSync(path.join(deps.secretsDir, f));
        const models: string[] = [];
        if (has('ANTHROPIC_API_KEY')) models.push('anthropic/claude-opus-5-5');
        if (has('OPENAI_API_KEY')) models.push('openai/gpt-6-astra');
        models.push('stub');
        return json(res, 200, { models });
      }
      if (p === '/api/secrets' && req.method === 'GET') return json(res, 200, { secrets: secretNames() });
      if (p === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });

      const apiRun = /^\/api\/runs\/([^/]+)(?:\/(approve|reject|cancel|rerun|events|screenshots|network))?$/.exec(p);
      if (apiRun) {
        const [, id, sub] = apiRun;
        if (!sub && req.method === 'GET') return json(res, 200, await runDetail(id));
        if (sub === 'events' && req.method === 'GET') return serveEvents(req, res, id);
        if (sub === 'screenshots' && req.method === 'GET') {
          requireRunDir(id);
          let shots: string[] = [];
          try {
            shots = fs
              .readdirSync(path.join(artDir(id), 'screenshots'))
              .filter((f) => /^[A-Za-z0-9._-]+\.png$/i.test(f) && fs.statSync(path.join(artDir(id), 'screenshots', f)).isFile())
              .sort();
          } catch {
            /* no screenshots dir yet */
          }
          return json(res, 200, { screenshots: shots });
        }
        if (sub === 'network' && req.method === 'GET') {
          requireRunDir(id);
          const art = artDir(id);
          return json(
            res,
            200,
            networkEntries(readText(path.join(art, 'network.jsonl')), readText(path.join(art, 'logs', 'proxy-access.log'))),
          );
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        if (sub === 'approve' || sub === 'reject') {
          const body = JSON.parse((await readBody(req, JSON_CAP)).toString('utf8') || '{}');
          writeDecision(id, body, sub);
          return json(res, 200, { ok: true });
        }
        if (sub === 'cancel') {
          requireRunDir(id);
          try {
            const r = await deps.runner.cancel(id);
            return json(res, 200, { state: r.state });
          } catch (err) {
            throw new HttpError(502, `runner cancel failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (sub === 'rerun') {
          const nid = await rerun(id).catch((err) => {
            throw err instanceof HttpError ? err : new HttpError(502, `rerun failed: ${err instanceof Error ? err.message : String(err)}`);
          });
          return json(res, 201, { run_id: nid });
        }
        return json(res, 404, { error: 'not found' });
      }

      // Artifact paths are checked on the RAW url: new URL() already collapses dot
      // segments (literal and %2e), so defence-in-depth needs the un-normalised form.
      const rawPath = (req.url ?? '/').split('?')[0];
      if (rawPath.startsWith('/artifacts/') && req.method === 'GET') {
        return serveArtifact(req, res, rawPath.slice('/artifacts/'.length).split('/'));
      }
      if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
      if (req.method === 'GET') return serveStatic(res, p);
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof HttpError) return json(res, err.code, { error: err.message });
      if (err instanceof FormError || err instanceof MultipartError) return json(res, 400, { error: err.message });
      if (err instanceof SyntaxError || (err instanceof Error && err.name === 'ZodError')) {
        return json(res, 400, { error: `invalid body: ${err.message}` });
      }
      return json(res, 500, { error: String(err) });
    }
  };
}
