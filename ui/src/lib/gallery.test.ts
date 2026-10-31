import { describe, expect, it } from 'vitest';
import type { Report } from './api.ts';
import { baseName, flattenGroups, groupScreenshots, shotsFromRefs, stepIndex } from './gallery.ts';

describe('stepIndex', () => {
  it('wraps in both directions', () => {
    expect(stepIndex(0, 1, 3)).toBe(1);
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(1, -7, 3)).toBe(0);
    expect(stepIndex(0, 1, 0)).toBe(0);
  });
});

describe('screenshot sequences', () => {
  it('groups by plan step, then the rest, and flattens in display order', () => {
    const report = {
      plan: {
        steps: [
          { id: 'p1', intent: 'log in', screenshots: ['screenshots/a.png'] },
          { id: 'p2', intent: 'post', screenshots: [] },
          { id: 'p3', intent: 'verify', screenshots: ['screenshots/b.png', 'screenshots/c.png'] },
        ],
      },
      artifacts: { screenshots: ['screenshots/a.png', 'screenshots/z.png'] },
    } as unknown as Report;
    const groups = groupScreenshots(report, []);
    expect(groups.map((g) => g.label)).toEqual(['p1 — log in', 'p3 — verify', 'other']);
    const shots = flattenGroups('r', groups);
    expect(shots.map((s) => baseName(s.ref))).toEqual(['a.png', 'b.png', 'c.png', 'z.png']);
    expect(shots[3]).toEqual({ ref: 'screenshots/z.png', src: '/artifacts/r/screenshots/z.png', group: 'other' });
  });
  it('dedupes evidence references that point at the same file', () => {
    const shots = shotsFromRefs('r', [
      { ref: 'final.png', group: 'c1' },
      { ref: 'screenshots/final.png', group: 'c2' },
      { ref: 'x.png', group: 'c2' },
    ]);
    expect(shots.map((s) => [s.src, s.group])).toEqual([
      ['/artifacts/r/screenshots/final.png', 'c1'],
      ['/artifacts/r/screenshots/x.png', 'c2'],
    ]);
  });
});
