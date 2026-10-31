import { describe, expect, it } from 'vitest';
import type { Plan } from './api.ts';
import { planChanges, planProblems, renumber } from './planEdit.ts';

const plan: Plan = {
  title: 'Blog',
  steps: [
    { id: 'p1', intent: 'log in', expected: 'admin shown' },
    { id: 'p2', intent: 'create post', expected: 'post saved' },
    { id: 'p3', intent: 'verify', expected: 'listed publicly' },
  ],
  criteria: [{ id: 'c1', description: 'post is public' }],
};

describe('renumber', () => {
  it('keeps ids sequential after removals/additions', () => {
    const next = renumber({
      title: 'x',
      steps: [
        { id: 'p2', intent: 'a', expected: 'b' },
        { id: 'p9', intent: 'c', expected: 'd' },
      ],
      criteria: [
        { id: 'c4', description: 'x' },
        { id: 'c7', description: 'y' },
      ],
    });
    expect(next.steps.map((s) => s.id)).toEqual(['p1', 'p2']);
    expect(next.criteria.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(next.steps[0]).toMatchObject({ intent: 'a', expected: 'b' });
  });
});

describe('planChanges (plan editor diff)', () => {
  it('detects edited, added, removed and retitled', () => {
    const next: Plan = {
      title: 'Edited',
      steps: [
        { id: 'p1', intent: 'log in CHANGED', expected: 'admin shown' },
        { id: 'p3', intent: 'verify', expected: 'listed publicly' },
        { id: 'p4', intent: 'new step', expected: 'new expected' },
      ],
      criteria: [
        { id: 'c1', description: 'post is public' },
        { id: 'c2', description: 'image shown' },
      ],
    };
    const changes = planChanges(plan, next);
    const kinds = changes.map((c) => `${c.kind}:${c.id}`).sort();
    expect(kinds).toEqual(['added:c2', 'added:p4', 'edited:p1', 'removed:p2', 'retitled:-']);
  });
  it('returns empty for identical plans', () => {
    expect(planChanges(plan, structuredClone(plan))).toEqual([]);
  });
});

describe('planProblems', () => {
  it('flags empty fields and cardinality', () => {
    expect(planProblems(plan)).toEqual([]);
    const bad: Plan = { title: '', steps: [{ id: 'p1', intent: ' ', expected: 'ok' }], criteria: [] };
    const probs = planProblems(bad);
    expect(probs.join(' ')).toContain('title');
    expect(probs.join(' ')).toContain('p1');
    expect(probs.join(' ')).toContain('criteria');
  });
});
