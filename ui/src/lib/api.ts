// Control-plane API client (SPEC §16.2). All calls are same-origin relative paths;
// mutations send JSON or multipart bodies — the browser adds the Origin header and
// the server 403s anything else.

export interface RunRow {
  run_id: string;
  title: string | null;
  model: string | null;
  submitted_at: string | null;
  runner_state: string | null;
  phase: string | null;
  status: string;
  exit_code: number | null;
  summary: string | null;
  started_at: string | null;
  ended_at: string | null;
  steps: number | null;
  tokens: { input?: number; output?: number } | null;
}

export interface StatusInfo {
  phase: string;
  plan_step: string | null;
  step_id: string | null;
  updated_at: string;
}

export interface PlanStep {
  id: string;
  intent: string;
  expected: string;
}
export interface PlanCriterion {
  id: string;
  description: string;
}
export interface Plan {
  title: string;
  steps: PlanStep[];
  criteria: PlanCriterion[];
}

export interface EvaluationCriterion {
  id: string;
  status: 'MET' | 'NOT_MET' | 'UNCLEAR';
  evidence: string;
  screenshots: string[];
}
export interface EvaluationIssue {
  severity: 'high' | 'medium' | 'low';
  title: string;
  description: string;
  plan_step: string | null;
  screenshot: string | null;
}
export interface Evaluation {
  criteria: EvaluationCriterion[];
  issues: EvaluationIssue[];
  conclusions: string;
}

export interface RunJson {
  run_id: string;
  test?: string;
  status: string;
  summary?: string;
  exit_code?: number;
  started_at?: string;
  ended_at?: string;
  chrome_version?: string;
  model?: string;
  steps?: number;
  tokens?: { input?: number; output?: number };
  egress?: { allowed: number; denied: { host: string; count: number }[] } | null;
  durations?: { raw_s: number | null; final_s: number | null };
}

export interface ReportStep {
  id: string;
  intent: string;
  expected: string;
  outcome: string;
  notes: string | null;
  chapter_start: number | null;
  screenshots: string[];
}
export interface ReportCriterion {
  id: string;
  description: string;
  verified: boolean;
  evaluator_status: string;
  evidence: string;
  screenshots: string[];
  assertions: { step_id: string; label: string; passed: boolean }[];
}
export interface Report {
  run_id: string;
  title: string;
  status: string;
  summary: string;
  model: string;
  start_url: string;
  instructions: string;
  timing: { started_at: string; ended_at: string };
  tokens: { input: number; output: number };
  chrome_version: string;
  egress: { allowed: number; denied: { host: string; count: number }[] } | null;
  plan: { title: string; steps: ReportStep[]; criteria: ReportCriterion[] } | null;
  issues: EvaluationIssue[];
  conclusions: string;
  assertions: { step_id: string; label: string; criterion: string | null; passed: boolean }[];
  artifacts: { video: string; raw_video: string; chapters_vtt: string; screenshots: string[] };
}

/** §16.3 live progress snapshot (detail API field + SSE `progress` event). */
export interface LiveStepEntry {
  step_id: string;
  kind: string;
  label: string;
  plan_step: string | null;
  result: 'running' | 'passed' | 'failed' | string;
  error?: string;
}
export interface LiveProgress {
  phase: string | null;
  plan_step: string | null;
  step_id: string | null;
  plan_steps: { id: string; status: string }[];
  steps: LiveStepEntry[];
  latest_screenshot: string | null;
  counters: { elapsed_s: number | null; steps: number; tokens: { input: number; output: number } };
  events: number;
}

export interface RunDetail {
  run_id: string;
  request: Record<string, unknown> | null;
  spec: Record<string, unknown> | null;
  runner_state: string | null;
  status: StatusInfo | null;
  run: RunJson | null;
  plan: Plan | null;
  evaluation: Evaluation | null;
  report: Report | null;
  events: { count: number; tail: unknown[] };
  progress: LiveProgress | null;
}

export interface Chapter {
  id: string;
  title: string;
  status: string;
  start: number;
  end: number;
  plan_step?: string | null;
}
export interface ChaptersFile {
  run_id: string;
  test: string;
  status: string;
  summary?: string;
  duration: number;
  video: string;
  chapters: Chapter[];
}

export interface TimelineEvent {
  seq: number;
  t_ms: number;
  type: string;
  step_id?: string;
  label?: string;
  action?: string;
  mode?: string;
  status?: string;
  error?: string;
  plan_step?: string | null;
  summary?: string;
  run_id?: string;
  test?: string;
  model?: string;
  file?: string;
  video_start_ms?: number;
  [k: string]: unknown;
}

export class ApiError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

async function parse(res: Response): Promise<unknown> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`);
  return body;
}

export async function apiGet<T>(path: string): Promise<T> {
  return (await parse(await fetch(path))) as T;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return (await parse(
    await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }),
  )) as T;
}

export async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  // Content-Type is left to the browser so the multipart boundary is set correctly.
  return (await parse(await fetch(path, { method: 'POST', body: form }))) as T;
}

export const artifactUrl = (runId: string, rel: string): string => `/artifacts/${runId}/${rel}`;

/** Screenshot references arrive as 'screenshots/x.png' or as bare names ('final.png'). */
export const screenshotUrl = (runId: string, ref: string): string =>
  artifactUrl(runId, ref.startsWith('screenshots/') ? ref : `screenshots/${ref}`);
