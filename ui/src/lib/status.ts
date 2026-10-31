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

export const FILTERABLE = [
  'all',
  'queued',
  'planning',
  'awaiting_approval',
  'running',
  'evaluating',
  'postprocessing',
  'passed',
  'failed',
  'unverified',
  'cancelled',
] as const;

export function matchesFilter(row: RunRow, filter: string): boolean {
  if (filter === 'all') return true;
  return badgeOf(row.status).cls === filter;
}

export function fmtDuration(started: string | null, ended: string | null, now = Date.now()): string {
  if (!started) return '—';
  const ms = (ended ? Date.parse(ended) : now) - Date.parse(started);
  if (Number.isNaN(ms) || ms < 0) return '—';
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
