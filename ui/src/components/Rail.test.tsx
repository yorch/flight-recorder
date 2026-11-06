import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRow } from '../lib/api.ts';
import { resetRunsStore } from '../lib/runsStore.ts';
import { Rail, rosterOf } from './Rail.tsx';

const row = (id: string, status: string, title: string): RunRow =>
  ({ run_id: id, status, title, started_at: '2026-10-31T12:00:00Z', ended_at: null, submitted_at: null }) as RunRow;
const runs = [
  row('20261031-120000-aaaa', 'cancelled', 'Cancelled thing'),
  row('20261031-120100-bbbb', 'running', 'Live one'),
  row('20261031-120200-cccc', 'PASSED', 'Done one'),
];

describe('Rail', () => {
  beforeEach(() => {
    resetRunsStore();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ runs }), { status: 200 })),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('orders the roster live-first', () => {
    const { live, recent } = rosterOf(runs);
    expect(live.map((r) => r.title)).toEqual(['Live one']);
    expect(recent.map((r) => r.title)).toEqual(['Cancelled thing', 'Done one']);
    expect(rosterOf(null)).toEqual({ live: [], recent: [] });
  });

  it('lists runs as links, marks the current one, and has no action-like buttons', async () => {
    const v = render(<Rail route={{ name: 'run', id: '20261031-120200-cccc' }} onHelp={() => {}} />);
    await waitFor(() => expect(v.container.querySelectorAll('.roster-item')).toHaveLength(3));
    expect(v.container.querySelector('[aria-current="page"].roster-item')?.textContent).toContain('Done one');
    // The rail precedes the canvas in DOM order; e2e drivers click the first
    // button:has-text("Cancel"|"Rerun"|"Approve plan"), so the rail must never offer one.
    for (const b of v.container.querySelectorAll('button')) expect(b.textContent).not.toMatch(/cancel|rerun|approve plan/i);
    expect(v.getByText('control plane linked')).toBeTruthy();
  });
});
