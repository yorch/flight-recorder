import { describe, expect, it } from 'vitest';
import { fmtAgo, fmtCount, fmtElapsed, toneOf } from './status.ts';

describe('toneOf (status colour language)', () => {
  it('maps every family of value to one tone', () => {
    for (const v of ['passed', 'PASSED', 'MET', 'VERIFIED', 'done', '2xx']) expect(toneOf(v)).toBe('ok');
    for (const v of ['failed', 'NOT_MET', 'error', 'high', '4xx', '5xx']) expect(toneOf(v)).toBe('bad');
    for (const v of ['awaiting_approval', 'awaiting approval', 'UNVERIFIED', 'UNCLEAR', 'medium']) expect(toneOf(v)).toBe('warn');
    for (const v of ['running', 'starting', 'postprocessing', '3xx']) expect(toneOf(v)).toBe('live');
    for (const v of ['planning', 'evaluating']) expect(toneOf(v)).toBe('model');
    for (const v of ['queued', 'cancelled', 'open', 'pending', '', null, undefined, 'whatever']) expect(toneOf(v)).toBe('idle');
  });
});

describe('formatters', () => {
  it('fmtElapsed', () => {
    expect(fmtElapsed(null)).toBe('—');
    expect(fmtElapsed(undefined)).toBe('—');
    expect(fmtElapsed(0)).toBe('0s');
    expect(fmtElapsed(42.4)).toBe('42s');
    expect(fmtElapsed(187)).toBe('3m 07s');
  });
  it('fmtCount', () => {
    expect(fmtCount(null)).toBe('—');
    expect(fmtCount(950)).toBe('950');
    expect(fmtCount(1234)).toBe('1.2k');
    expect(fmtCount(48_200)).toBe('48k');
    expect(fmtCount(3_100_000)).toBe('3.1M');
  });
  it('fmtAgo', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    expect(fmtAgo(null, now)).toBe('—');
    expect(fmtAgo('garbage', now)).toBe('—');
    expect(fmtAgo('2026-10-31T11:59:58Z', now)).toBe('now');
    expect(fmtAgo('2026-10-31T11:59:15Z', now)).toBe('45s');
    expect(fmtAgo('2026-10-31T11:48:00Z', now)).toBe('12m');
    expect(fmtAgo('2026-10-31T09:00:00Z', now)).toBe('3h');
    expect(fmtAgo('2026-10-29T12:00:00Z', now)).toBe('2d');
  });
});
