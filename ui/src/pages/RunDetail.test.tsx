import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChaptersFile, Report, RunDetail } from '../lib/api.ts';
import { RunDetailPage } from './RunDetail.tsx';

// Selector contract with tests/acceptance/tools/ui-e2e.mjs and live-progress-e2e.mjs:
// these assertions mirror what the Playwright drivers rely on.

const ID = '20261031-120000-abcd';
const plan = {
  title: 'Blog post',
  steps: [
    { id: 'p1', intent: 'Sign in', expected: 'Dashboard' },
    { id: 'p2', intent: 'Publish post', expected: 'Post visible' },
  ],
  criteria: [{ id: 'c1', description: 'Post is public' }],
};
const base: RunDetail = {
  run_id: ID,
  request: { form: { title: 'UI e2e blog' }, model: 'stub' },
  spec: null,
  runner_state: 'running',
  status: { phase: 'running', plan_step: 'p2', step_id: 's0003', updated_at: '2026-10-31T12:00:05Z' },
  run: null,
  plan,
  evaluation: null,
  report: null,
  events: { count: 0, tail: [] },
  progress: {
    phase: 'running',
    plan_step: 'p2',
    step_id: 's0003',
    plan_steps: [
      { id: 'p1', status: 'done' },
      { id: 'p2', status: 'running' },
    ],
    steps: [
      { step_id: 's0001', kind: 'click', label: 'Click Sign in', plan_step: 'p1', result: 'passed' },
      { step_id: 's0002', kind: 'type', label: 'Type title', plan_step: 'p2', result: 'running' },
    ],
    latest_screenshot: 's0002.png',
    counters: { elapsed_s: 12, steps: 2, tokens: { input: 1200, output: 80 } },
    events: 9,
  },
};
const report: Report = {
  run_id: ID,
  title: 'Blog post',
  status: 'PASSED',
  summary: 'all criteria met',
  model: 'stub',
  start_url: 'http://app.test/',
  instructions: 'x',
  timing: { started_at: '2026-10-31T12:00:00Z', ended_at: '2026-10-31T12:01:00Z' },
  tokens: { input: 10, output: 5 },
  chrome_version: '150',
  egress: { allowed: 12, denied: [{ host: 'evil.test', count: 2 }] },
  plan: {
    title: 'Blog post',
    steps: [
      {
        id: 'p1',
        intent: 'Sign in',
        expected: 'Dashboard',
        outcome: 'done',
        notes: null,
        chapter_start: 0,
        screenshots: ['screenshots/a.png'],
      },
      {
        id: 'p2',
        intent: 'Publish post',
        expected: 'Post visible',
        outcome: 'done',
        notes: null,
        chapter_start: 2,
        screenshots: ['screenshots/b.png'],
      },
    ],
    criteria: [
      {
        id: 'c1',
        description: 'Post is public',
        verified: true,
        evaluator_status: 'MET',
        evidence: 'seen',
        screenshots: ['b.png'],
        assertions: [],
      },
    ],
  },
  issues: [{ severity: 'low', title: 'Slow save', description: 'took 3 s', plan_step: 'p2', screenshot: null }],
  conclusions: 'The blog flow works.',
  assertions: [{ step_id: 's0004', label: 'url', criterion: 'c1', passed: true }],
  artifacts: {
    video: 'final.mp4',
    raw_video: 'raw.mkv',
    chapters_vtt: 'chapters.vtt',
    screenshots: ['screenshots/a.png', 'screenshots/b.png'],
  },
};
const chapters: ChaptersFile = {
  run_id: ID,
  test: 'blog',
  status: 'PASSED',
  duration: 10,
  video: 'final.mp4',
  chapters: [
    { id: 's0000', title: 'Open', status: 'PASSED', start: 0, end: 2 },
    { id: 's0001', title: 'p1 · Sign in', status: 'PASSED', start: 2, end: 10, plan_step: 'p1' },
  ],
};
const terminal: RunDetail = {
  ...base,
  runner_state: 'exited',
  status: { phase: 'passed', plan_step: null, step_id: null, updated_at: '2026-10-31T12:01:00Z' },
  run: { run_id: ID, status: 'PASSED', exit_code: 0, steps: 6, tokens: { input: 10, output: 5 }, egress: report.egress },
  report,
};
const events = [
  { seq: 1, t_ms: 1000, type: 'RUN_START', test: 'blog' },
  { seq: 2, t_ms: 1500, type: 'ACTION_START', step_id: 's0001', label: 'Click Sign in' },
  { seq: 3, t_ms: 1900, type: 'ACTION_END', step_id: 's0001', status: 'PASSED' },
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function stubApi(detail: RunDetail) {
  const posts: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(url);
      return json(url.endsWith('/rerun') ? { run_id: '20261031-130000-ffff' } : { ok: true });
    }
    if (url === `/api/runs/${ID}`) return json(detail);
    if (url.endsWith('/screenshots')) return json({ screenshots: ['s0001.png', 's0002.png'] });
    if (url.endsWith('/network'))
      return json({ source: 'cdp', truncated: false, entries: [{ seq: 1, method: 'GET', url: 'http://app.test/', status: 500 }] });
    if (url.endsWith('chapters.json')) return json(chapters);
    if (url.endsWith('events.jsonl')) return new Response(events.map((e) => JSON.stringify(e)).join('\n'));
    return json({ error: 'nope' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return posts;
}

class FakeEventSource {
  static CLOSED = 2;
  readyState = 1;
  onmessage: ((m: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener() {}
  close() {
    this.readyState = 2;
  }
}

const one = (c: HTMLElement, testId: string) => {
  const els = c.querySelectorAll(`[data-testid="${testId}"]`);
  expect(els, testId).toHaveLength(1);
  return els[0] as HTMLElement;
};
const isShown = (el: Element | null) => {
  for (let e = el; e; e = e.parentElement) if (e.hasAttribute('hidden')) return false;
  return el !== null;
};
/** What Playwright's `button:has-text("X")` would click first. */
const firstButton = (re: RegExp) => [...document.querySelectorAll('button')].find((b) => re.test(b.textContent ?? ''));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
});

describe('RunDetailPage', () => {
  beforeEach(() => {
    window.location.hash = `#/run/${ID}`;
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  it('live run: phase, telemetry, plan track, step log, feed and timeline are wired', async () => {
    stubApi(base);
    const v = render(<RunDetailPage id={ID} />);
    await waitFor(() => expect(one(v.container, 'live-progress')).toBeTruthy());
    expect(one(v.container, 'phase').textContent).toBe('running');
    expect(one(v.container, 'live-phase').textContent).toBe('running · step p2');
    expect(one(v.container, 'counter-steps').textContent).toMatch(/^\d+$/);
    expect(one(v.container, 'counter-tokens').textContent).toBe('1200 / 80');
    expect(one(v.container, 'counter-elapsed').textContent).toBe('12s');
    expect(one(v.container, 'plan-step-statuses').querySelectorAll('li')).toHaveLength(2);
    expect(one(v.container, 'plan-step-statuses').textContent).toContain('Publish post');
    const log = one(v.container, 'step-log').querySelectorAll('tbody tr');
    expect(log).toHaveLength(2);
    expect(log[0]?.querySelectorAll('td').length).toBeGreaterThanOrEqual(4);
    expect(log[0]?.textContent).toContain('s0002'); // newest first
    await waitFor(() =>
      expect(one(v.container, 'live-shot').querySelector('img')?.getAttribute('src')).toBe(`/artifacts/${ID}/screenshots/s0002.png`),
    );
    expect(isShown(one(v.container, 'live-shot'))).toBe(true);
    expect(v.queryByTestId('plan-panel')).toBeNull(); // the plan track replaces it while running
    // The first "Cancel" button in DOM order is the run action (rail/tabs come first in the shell).
    expect(firstButton(/cancel/i)?.className).toContain('danger');
    expect(firstButton(/cancel/i)?.hasAttribute('disabled')).toBe(false);
  });

  it('awaiting approval: editable plan on the default tab and an Approve plan button', async () => {
    const posts = stubApi({
      ...base,
      status: { ...(base.status as NonNullable<RunDetail['status']>), phase: 'awaiting_approval' },
      progress: null,
    });
    const v = render(<RunDetailPage id={ID} />);
    await waitFor(() => expect(one(v.container, 'phase').textContent).toBe('awaiting approval'));
    const panel = one(v.container, 'plan-panel');
    expect(isShown(panel)).toBe(true);
    expect(panel.querySelector('input')).not.toBeNull();
    expect(panel.querySelectorAll('tbody tr').length).toBeGreaterThanOrEqual(2);
    expect(v.queryByTestId('step-log')).toBeNull();
    const approve = firstButton(/approve plan/i) as HTMLButtonElement;
    expect(panel.contains(approve)).toBe(true);
    await act(async () => fireEvent.click(approve));
    expect(posts).toContain(`/api/runs/${ID}/approve`);
  });

  it('terminal run: verdict, conclusions, video + chapters visible; gallery and timeline mounted', async () => {
    stubApi(terminal);
    const v = render(<RunDetailPage id={ID} />);
    await waitFor(() => expect(one(v.container, 'verdict').textContent).toContain('PASSED'));
    expect(one(v.container, 'phase').textContent).toBe('passed');
    expect(one(v.container, 'conclusions').textContent).toContain('The blog flow works.');
    expect(v.queryByTestId('live-progress')).toBeNull();
    await waitFor(() => expect(one(v.container, 'chapter-list').querySelectorAll('.chapter')).toHaveLength(2));
    expect(isShown(one(v.container, 'chapter-list'))).toBe(true);
    expect(v.container.querySelector('video[data-testid="run-video"]')?.getAttribute('src')).toBe(`/artifacts/${ID}/final.mp4`);
    // Gallery sits in a hidden tab: its images must load eagerly.
    const imgs = one(v.container, 'gallery').querySelectorAll('img');
    expect(imgs.length).toBe(2);
    for (const img of imgs) expect(img.getAttribute('loading')).not.toBe('lazy');
    await waitFor(() => expect(one(v.container, 'timeline').querySelectorAll('tbody tr')).toHaveLength(3));
    expect(firstButton(/cancel/i)?.hasAttribute('disabled')).toBe(true);
    expect(v.getByText('evil.test')).toBeTruthy();
  });

  it('tabs switch panels, persist in the hash and support arrow keys', async () => {
    stubApi(terminal);
    const v = render(<RunDetailPage id={ID} />);
    await waitFor(() => expect(one(v.container, 'verdict')).toBeTruthy());
    const tab = (name: RegExp) => v.getByRole('tab', { name });
    fireEvent.click(tab(/Network/));
    expect(window.location.hash).toBe(`#/run/${ID}?tab=network`);
    expect(tab(/Network/).getAttribute('aria-selected')).toBe('true');
    expect(isShown(one(v.container, 'network-panel'))).toBe(true);
    expect(isShown(one(v.container, 'verdict'))).toBe(false);
    await waitFor(() => expect(tab(/Network/).textContent).toContain('1'));
    fireEvent.keyDown(tab(/Network/), { key: 'ArrowRight' });
    expect(window.location.hash).toBe(`#/run/${ID}?tab=artifacts`);
    fireEvent.keyDown(tab(/Artifacts/), { key: 'Home' });
    expect(window.location.hash).toBe(`#/run/${ID}`);
    expect(tab(/Evidence/).textContent).toContain('2');
  });

  it('rerun navigates to the new run id', async () => {
    const posts = stubApi(terminal);
    const v = render(<RunDetailPage id={ID} />);
    await waitFor(() => expect(one(v.container, 'verdict')).toBeTruthy());
    await act(async () => fireEvent.click(firstButton(/rerun/i) as HTMLButtonElement));
    expect(posts).toContain(`/api/runs/${ID}/rerun`);
    expect(window.location.hash).toBe('#/run/20261031-130000-ffff');
  });
});
