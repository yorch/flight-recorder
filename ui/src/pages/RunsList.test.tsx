import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRow } from '../lib/api.ts';
import { RunsList } from './RunsList.tsx';

const row = (id: string, status: string, title: string, model: string, steps: number | null, started: string): RunRow => ({
  run_id: id,
  title,
  model,
  submitted_at: started,
  runner_state: null,
  phase: null,
  status,
  exit_code: null,
  summary: null,
  started_at: started,
  ended_at: null,
  steps,
  tokens: null,
});
const runs = [
  row('20261030-120000-aaaa', 'PASSED', 'Login works', 'stub', 6, '2026-10-30T12:00:00Z'),
  row('20261030-130000-bbbb', 'FAILED', 'Blog post', 'anthropic/claude-opus-5-5', 25, '2026-10-30T13:00:00Z'),
  row('20261030-140000-cccc', 'running', 'Checkout', 'stub', 2, '2026-10-30T14:00:00Z'),
];
const titles = (c: HTMLElement) => [...c.querySelectorAll('[data-testid="runs-table"] tbody tr a')].map((a) => a.textContent);

describe('RunsList', () => {
  beforeEach(() => {
    window.location.hash = '#/';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ runs }), { status: 200 })),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  it('sorts by a column header and writes the state to the hash', async () => {
    const v = render(<RunsList />);
    await waitFor(() => expect(titles(v.container)).toHaveLength(3));
    fireEvent.click(within(v.getByRole('columnheader', { name: 'Steps' })).getByRole('button'));
    expect(titles(v.container)).toEqual(['Checkout', 'Login works', 'Blog post']);
    fireEvent.click(within(v.getByRole('columnheader', { name: 'Title' })).getByRole('button'));
    fireEvent.click(within(v.getByRole('columnheader', { name: 'Title' })).getByRole('button'));
    expect(titles(v.container)).toEqual(['Login works', 'Checkout', 'Blog post']);
    expect(window.location.hash).toBe('#/?sort=title%3Adesc');
  });

  it('applies filters and search from a shared URL', async () => {
    window.location.hash = '#/?f.model=stub&sort=created:desc';
    const v = render(<RunsList />);
    await waitFor(() => expect(titles(v.container)).toEqual(['Checkout', 'Login works']));
    fireEvent.change(v.getByLabelText('Search Test runs'), { target: { value: 'login' } });
    expect(titles(v.container)).toEqual(['Login works']);
    expect(new URLSearchParams(window.location.hash.split('?')[1]).get('q')).toBe('login');
  });

  it('stat tiles filter by status group', async () => {
    const v = render(<RunsList />);
    await waitFor(() => expect(titles(v.container)).toHaveLength(3));
    fireEvent.click(v.getByRole('button', { name: /Needs attention/ }));
    expect(titles(v.container)).toEqual(['Blog post']);
    expect(v.getByRole('button', { name: /Needs attention/ }).getAttribute('aria-pressed')).toBe('true');
    expect((v.getByLabelText('Filter by Status') as HTMLSelectElement).value).toBe('attention');
    fireEvent.click(v.getByRole('button', { name: /In progress/ }));
    expect(titles(v.container)).toEqual(['Checkout']);
    fireEvent.click(v.getByRole('button', { name: /Total runs/ }));
    expect(titles(v.container)).toHaveLength(3);
    expect(window.location.hash).toBe('#/');
  });
});
