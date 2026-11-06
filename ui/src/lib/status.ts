import type { RunRow } from './api.ts';

// Status merge display: the API already merges request → runner → status.json → run.json
// into `row.status`; here we normalise to the §16.3 badge set plus fallbacks.
export const TERMINAL = new Set(['passed', 'failed', 'unverified', 'cancelled']);
export const KNOWN = new Set([
  'submitted',
  'queued',
  'starting',
  'planning',
  'awaiting_approval',
  'running',
  'evaluating',
  'postprocessing',
  'exited',
  'passed',
  'failed',
  'unverified',
  'cancelled',
]);

export interface Badge {
  text: string;
  cls: string; // css class suffix on .badge
  terminal: boolean;
}

export function badgeOf(status: string | null | undefined): Badge {
  const s = (status ?? 'submitted').toLowerCase();
  const cls = KNOWN.has(s) ? s : 'submitted';
  return { text: s.replaceAll('_', ' '), cls, terminal: TERMINAL.has(s) };
}

export const badgeForRow = (row: Pick<RunRow, 'status'>): Badge => badgeOf(row.status);

export const isTerminalRow = (row: Pick<RunRow, 'status'>): boolean => badgeOf(row.status).terminal;

/** Virtual status groups usable as a status filter (stat tiles on the runs list). */
export const STATUS_GROUPS: Record<string, { label: string; match: (cls: string) => boolean }> = {
  active: { label: 'in progress', match: (cls) => !TERMINAL.has(cls) },
  attention: { label: 'needs attention', match: (cls) => ['failed', 'unverified', 'awaiting_approval'].includes(cls) },
};

export function matchesStatus(status: string | null | undefined, want: string): boolean {
  const cls = badgeOf(status).cls;
  return STATUS_GROUPS[want]?.match(cls) ?? cls === want;
}

export const statusLabel = (f: string): string => STATUS_GROUPS[f]?.label ?? f.replaceAll('_', ' ');

export function durationMs(started: string | null, ended: string | null, now = Date.now()): number | null {
  if (!started) return null;
  const ms = (ended ? Date.parse(ended) : now) - Date.parse(started);
  return Number.isNaN(ms) || ms < 0 ? null : ms;
}

export function fmtDuration(started: string | null, ended: string | null, now = Date.now()): string {
  const ms = durationMs(started, ended, now);
  if (ms === null) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s - m * 60)).padStart(2, '0')}s`;
}

export function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(11, 19);
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)}`;
}

/**
 * Tone language shared by every status mark in the console: one colour per
 * meaning, independent of where the value came from (run status, plan-step
 * outcome, criterion verdict, HTTP class, event status).
 */
export type Tone = 'ok' | 'bad' | 'warn' | 'live' | 'model' | 'idle';
const TONES: Record<string, Tone> = {
  passed: 'ok',
  met: 'ok',
  verified: 'ok',
  done: 'ok',
  ok: 'ok',
  success: 'ok',
  '2xx': 'ok',
  failed: 'bad',
  not_met: 'bad',
  error: 'bad',
  high: 'bad',
  '4xx': 'bad',
  '5xx': 'bad',
  awaiting_approval: 'warn',
  unverified: 'warn',
  unclear: 'warn',
  skipped: 'warn',
  medium: 'warn',
  running: 'live',
  starting: 'live',
  postprocessing: 'live',
  '3xx': 'live',
  planning: 'model',
  evaluating: 'model',
  thinking: 'model',
};

export function toneOf(value: string | null | undefined): Tone {
  const v = (value ?? '').trim().toLowerCase().replaceAll(' ', '_');
  return TONES[v] ?? 'idle';
}

/** Elapsed seconds as `42s` / `3m 07s`. */
export function fmtElapsed(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return '—';
  const whole = Math.max(0, Math.round(s));
  const m = Math.floor(whole / 60);
  return m > 0 ? `${m}m ${String(whole - m * 60).padStart(2, '0')}s` : `${whole}s`;
}

/** Compact counts for dense readouts: 950, 12.4k, 3.1M. */
export function fmtCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a < 1000) return String(n);
  if (a < 1_000_000) return `${(n / 1000).toFixed(a < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Relative age for the run roster: `now`, `45s`, `12m`, `3h`, `2d`. */
export function fmtAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
