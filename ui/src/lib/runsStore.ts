import { useSyncExternalStore } from 'react';
import { apiGet, type RunRow } from './api.ts';
import { isTerminalRow } from './status.ts';

// One shared poller for GET /api/runs: the rail roster and the runs board read
// the same snapshot. Polls every 2 s while any run is live, else every 5 s, and
// only while something is subscribed.

export interface RunsSnapshot {
  runs: RunRow[] | null;
  error: string | null;
  updatedAt: number | null;
}

let snap: RunsSnapshot = { runs: null, error: null, updatedAt: null };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

const emit = () => {
  for (const l of listeners) l();
};

export async function refreshRuns(): Promise<RunRow[] | null> {
  try {
    const { runs } = await apiGet<{ runs: RunRow[] }>('/api/runs');
    snap = { runs, error: null, updatedAt: Date.now() };
    emit();
    return runs;
  } catch (err) {
    snap = { ...snap, error: err instanceof Error ? err.message : String(err) };
    emit();
    return null;
  }
}

export const pollDelay = (runs: readonly RunRow[] | null): number => (runs?.some((r) => !isTerminalRow(r)) ? 2000 : 5000);

function schedule() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (listeners.size === 0) return;
  timer = setTimeout(() => {
    void refreshRuns().then(schedule);
  }, pollDelay(snap.runs));
}

export function subscribeRuns(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1) void refreshRuns().then(schedule);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export const runsSnapshot = (): RunsSnapshot => snap;

/** Test hook: forget the cached snapshot. */
export function resetRunsStore(): void {
  snap = { runs: null, error: null, updatedAt: null };
}

export function useRuns(): RunsSnapshot {
  return useSyncExternalStore(subscribeRuns, runsSnapshot, runsSnapshot);
}
