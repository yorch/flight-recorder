import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Report } from '../lib/api.ts';
import { VerdictPanel, verdictStats } from './ReportPanel.tsx';

const report = {
  run_id: 'r',
  status: 'FAILED',
  summary: '1 criterion not met',
  timing: { started_at: '2026-10-31T12:00:00Z', ended_at: '2026-10-31T12:01:05Z' },
  plan: {
    title: 't',
    steps: [],
    criteria: [
      { id: 'c1', description: 'a', verified: true, evaluator_status: 'MET', evidence: '', screenshots: [], assertions: [] },
      { id: 'c2', description: 'b', verified: false, evaluator_status: 'NOT_MET', evidence: '', screenshots: [], assertions: [] },
      { id: 'c3', description: 'c', verified: false, evaluator_status: 'MET', evidence: '', screenshots: [], assertions: [] },
    ],
  },
  issues: [
    { severity: 'high', title: 'x', description: '', plan_step: null, screenshot: null },
    { severity: 'low', title: 'y', description: '', plan_step: null, screenshot: null },
  ],
  conclusions: '<b>not html</b>',
  assertions: [
    { step_id: 's1', label: 'u', criterion: null, passed: true },
    { step_id: 's2', label: 'v', criterion: null, passed: false },
  ],
} as unknown as Report;

afterEach(cleanup);

describe('VerdictPanel', () => {
  it('counts criteria, assertions and issues by severity', () => {
    expect(verdictStats(report)).toEqual({ met: 2, criteria: 3, sev: { high: 1, medium: 0, low: 1 }, assertions: 2, assertionsPassed: 1 });
  });

  it('renders the verdict with escaped conclusions', () => {
    const v = render(<VerdictPanel runId="r" report={report} run={null} />);
    expect(v.getByTestId('verdict').textContent).toContain('FAILED');
    expect(v.getByTestId('conclusions').textContent).toContain('<b>not html</b>');
    expect(v.getByTestId('conclusions').querySelector('b')).toBeNull();
    expect(v.getByText('1m 05s')).toBeTruthy();
    expect(v.getByTestId('report-panel').getAttribute('data-tone')).toBe('bad');
  });

  it('falls back to run.json for terminal runs without a report', () => {
    const v = render(
      <VerdictPanel runId="r" report={null} run={{ run_id: 'r', status: 'CANCELLED', summary: 'cancelled by user', exit_code: 4 }} />,
    );
    expect(v.getByText('CANCELLED')).toBeTruthy();
    expect(v.getByText('cancelled by user')).toBeTruthy();
    expect(v.queryByTestId('verdict')).toBeNull();
    expect(render(<VerdictPanel runId="r" report={null} run={null} />).container.innerHTML).toBe('');
  });
});
