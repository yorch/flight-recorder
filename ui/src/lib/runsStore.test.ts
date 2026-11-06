import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRow } from './api.ts';
import { pollDelay, refreshRuns, resetRunsStore, runsSnapshot, subscribeRuns } from './runsStore.ts';

const row = (status: string) => ({ run_id: '20261030-120000-aaaa', status }) as RunRow;
const ok = (runs: unknown[]) => new Response(JSON.stringify({ runs }), { status: 200 });

describe('runs store', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    resetRunsStore();
    fetchMock = vi.fn(async () => ok([row('running')]));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('polls faster while a run is live', () => {
    expect(pollDelay([row('running')])).toBe(2000);
    expect(pollDelay([row('PASSED')])).toBe(5000);
    expect(pollDelay(null)).toBe(5000);
  });

  it('shares one poller between subscribers and stops when the last one leaves', async () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeRuns(a);
    const offB = subscribeRuns(b);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(runsSnapshot().runs).toHaveLength(1);
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    offA();
    offB();
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the last rows and records the error when a refresh fails', async () => {
    await refreshRuns();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'down' }), { status: 502 }));
    expect(await refreshRuns()).toBeNull();
    expect(runsSnapshot().error).toBe('down');
    expect(runsSnapshot().runs).toHaveLength(1);
  });
});
