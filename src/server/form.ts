import crypto from 'node:crypto';
import { parseTestSpec, type TestSpec, type TestSpecInput } from '../config.ts';
import { providerOf } from '../runner/request.ts';

export class FormError extends Error {}

export interface CredentialInput {
  name: string;
  input_types: string[];
  origins?: string[];
}

/** The new-run form (§16.2), as decoded from JSON or multipart fields. */
export interface RunForm {
  title?: string;
  instructions: string;
  start_url: string;
  model: string; // '<provider>/<id>', 'stub', or 'stub/<label>'
  allowed_origins?: string[];
  allowed_hosts?: string[];
  credentials?: CredentialInput[];
  budgets?: { max_steps?: number; timeout_s?: number; max_model_tokens?: number };
  review_plan?: boolean;
  approval_timeout_s?: number;
  assets?: string[];
  stub_script?: unknown; // stub provider: script object (or JSON text) written to stub/script.json
}

/** §16.2: upload names are sanitised to [A-Za-z0-9._-]; null means unusable. */
export function sanitizeFilename(name: string): string | null {
  const base = (name.replace(/\\/g, '/').split('/').pop() ?? '').trim();
  const clean = base.replace(/[^A-Za-z0-9._-]/g, '_');
  if (clean === '' || /^\.+$/.test(clean)) return null;
  return clean;
}

/** §16.1 run_id shape: <yyyymmdd>-<hhmmss>-<4 hex>. */
export function newRunId(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  const clock = `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${day}-${clock}-${crypto.randomBytes(2).toString('hex')}`;
}

const DEFAULT_STUB_SCRIPT = { turns: [{ action: { kind: 'done', status: 'PASSED', summary: 'no stub script supplied' } }] };

/** Resolves the AGENT_MODEL value the runner/orchestrator will see. */
export function resolveModel(form: RunForm): string {
  const m = (form.model ?? '').trim();
  if (!m) throw new FormError('model is required');
  if (m === 'stub' || m.startsWith('stub/')) return 'stub//run-input/stub/script.json';
  if (!providerOf(m)) throw new FormError(`unknown model provider in '${m}' (expected anthropic|openai|stub)`);
  return m;
}

export function isStubModel(model: string): boolean {
  return model === 'stub' || model.startsWith('stub/');
}

/** Stub script text for stub/script.json in the request dir (null for real providers). */
export function stubScriptText(form: RunForm): string | null {
  if (!isStubModel(form.model ?? '')) return null;
  const s = form.stub_script;
  if (s === undefined || s === null || s === '') return `${JSON.stringify(DEFAULT_STUB_SCRIPT)}\n`;
  if (typeof s === 'string') {
    try {
      JSON.parse(s);
    } catch {
      throw new FormError('stub_script is not valid JSON');
    }
    return s.endsWith('\n') ? s : `${s}\n`;
  }
  return `${JSON.stringify(s)}\n`;
}

/**
 * §16.2 form → spec.json: title→name, instructions→goal, credentials→secret bindings
 * (origins default to the start origin), extra hosts→allowed_hosts, budgets, review_plan,
 * assets. The result is validated with the TestSpec zod; allowed_origins defaults apply.
 */
export function buildSpec(form: RunForm): TestSpec {
  const instructions = (form.instructions ?? '').trim();
  if (!instructions) throw new FormError('instructions are required');
  let startOrigin: string;
  try {
    const u = new URL(form.start_url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
    startOrigin = u.origin;
  } catch {
    throw new FormError('start_url must be an http(s) URL');
  }

  const secrets: Record<string, { origins: string[]; input_types: string[] }> = {};
  for (const c of form.credentials ?? []) {
    if (!/^[A-Za-z0-9_]+$/.test(c.name ?? '')) throw new FormError(`invalid credential name '${String(c.name)}'`);
    if (!Array.isArray(c.input_types) || c.input_types.length === 0 || c.input_types.some((t) => typeof t !== 'string' || !t)) {
      throw new FormError(`credential '${c.name}' needs a non-empty input_types list`);
    }
    secrets[c.name] = { origins: c.origins?.length ? c.origins : [startOrigin], input_types: c.input_types };
  }

  const assets: string[] = [];
  for (const a of form.assets ?? []) {
    if (typeof a !== 'string' || sanitizeFilename(a) !== a) throw new FormError(`invalid asset name '${String(a)}'`);
    if (!assets.includes(a)) assets.push(a);
  }

  const raw: TestSpecInput & Record<string, unknown> = {
    name: (form.title ?? '').trim().slice(0, 80) || 'run',
    goal: instructions,
    start_url: form.start_url,
    allowed_origins: form.allowed_origins?.length ? form.allowed_origins : [startOrigin],
  };
  const title = (form.title ?? '').trim().slice(0, 80);
  if (title) raw.title = title;
  if (form.allowed_hosts?.length) raw.allowed_hosts = form.allowed_hosts;
  if (Object.keys(secrets).length > 0) raw.secrets = secrets;
  if (assets.length > 0) raw.assets = assets;
  if (form.review_plan) raw.review_plan = true;
  if (form.approval_timeout_s !== undefined) raw.approval_timeout_s = form.approval_timeout_s;
  if (form.budgets?.max_steps !== undefined) raw.max_steps = form.budgets.max_steps;
  if (form.budgets?.timeout_s !== undefined) raw.timeout_s = form.budgets.timeout_s;
  if (form.budgets?.max_model_tokens !== undefined) raw.max_model_tokens = form.budgets.max_model_tokens;

  try {
    return parseTestSpec(raw);
  } catch (err) {
    throw new FormError(`invalid run parameters: ${err instanceof Error ? err.message : String(err)}`);
  }
}
