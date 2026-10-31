import { describe, expect, it } from 'vitest';
import type { RunRow } from './api.ts';
import { badgeOf, durationMs, fmtDuration, isTerminalRow, matchesStatus, statusLabel } from './status.ts';

const row = (status: string): RunRow => ({
  run_id: '20261030-120000-aaaa',
  title: 't',
  model: 'stub',
  submitted_at: null,
  runner_state: null,
  phase: null,
  status,
  exit_code: null,
  summary: null,
  started_at: null,
  ended_at: null,
  steps: null,
  tokens: null,
});

describe('badgeOf (status merge display)', () => {
  it('maps each §16.3 badge', () => {
    for (const [status, cls, terminal] of [
      ['queued', 'queued', false],
      ['planning', 'planning', false],
      ['awaiting_approval', 'awaiting_approval', false],
      ['running', 'running', false],
      ['evaluating', 'evaluating', false],
      ['postprocessing', 'postprocessing', false],
      ['PASSED', 'passed', true],
      ['FAILED', 'failed', true],
      ['UNVERIFIED', 'unverified', true],
      ['CANCELLED', 'cancelled', true],
    ] as const) {
      const b = badgeOf(status);
      expect(b.cls).toBe(cls);
      expect(b.terminal).toBe(terminal);
      expect(b.text).not.toContain('_');
    }
  });
  it('falls back to submitted for unknown/empty', () => {
    expect(badgeOf(null).cls).toBe('submitted');
    expect(badgeOf('weird').cls).toBe('submitted');
  });
  it('isTerminalRow only for verdict statuses', () => {
    expect(isTerminalRow(row('running'))).toBe(false);
    expect(isTerminalRow(row('awaiting_approval'))).toBe(false);
    expect(isTerminalRow(row('PASSED'))).toBe(true);
    expect(isTerminalRow(row('exited'))).toBe(false);
  });
});

describe('matchesStatus', () => {
  it('matches the badge class, case-insensitively', () => {
    expect(matchesStatus('FAILED', 'failed')).toBe(true);
    expect(matchesStatus('FAILED', 'running')).toBe(false);
    expect(matchesStatus('awaiting_approval', 'awaiting_approval')).toBe(true);
    expect(matchesStatus(row('weird').status, 'submitted')).toBe(true);
  });
  it('supports the virtual active / attention groups', () => {
    expect(matchesStatus('running', 'active')).toBe(true);
    expect(matchesStatus('PASSED', 'active')).toBe(false);
    expect(matchesStatus('UNVERIFIED', 'attention')).toBe(true);
    expect(matchesStatus('awaiting_approval', 'attention')).toBe(true);
    expect(matchesStatus('PASSED', 'attention')).toBe(false);
    expect(statusLabel('active')).toBe('in progress');
    expect(statusLabel('awaiting_approval')).toBe('awaiting approval');
  });
});

describe('fmtDuration', () => {
  it('sub-minute, minutes, and open-ended runs', () => {
    const t0 = '2026-10-30T12:00:00.000Z';
    const t1 = '2026-10-30T12:00:09.200Z';
    const t2 = '2026-10-30T12:01:09.200Z';
    expect(fmtDuration(t0, t1)).toBe('9.2s');
    expect(fmtDuration(t0, t2)).toBe('1m 09s');
    expect(fmtDuration(t0, null, Date.parse(t1))).toBe('9.2s');
    expect(fmtDuration(null, null)).toBe('—');
    expect(durationMs(t0, t1)).toBe(9200);
    expect(durationMs(t1, t0)).toBeNull();
    expect(durationMs('nope', t0)).toBeNull();
  });
});
