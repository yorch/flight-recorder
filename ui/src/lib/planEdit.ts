import type { Plan } from './api.ts';

// Editable plan model used while a run is awaiting_approval (§15.2, §16.3).
// Steps keep sequential ids p1..pN and criteria c1..cN — the API revalidates
// with the strict Plan schema on approve, so the editor emits exactly that shape.

export function renumber(plan: Plan): Plan {
  return {
    title: plan.title,
    steps: plan.steps.map((s, i) => ({ id: `p${i + 1}`, intent: s.intent, expected: s.expected })),
    criteria: plan.criteria.map((c, i) => ({ id: `c${i + 1}`, description: c.description })),
  };
}

export const emptyPlan = (): Plan => ({
  title: 'plan',
  steps: [{ id: 'p1', intent: '', expected: '' }],
  criteria: [{ id: 'c1', description: '' }],
});

export interface PlanChange {
  kind: 'edited' | 'added' | 'removed' | 'retitled';
  id: string;
  detail?: string;
}

/** Structural diff between the submitted plan and the edited one (for confirm/tests). */
export function planChanges(orig: Plan, next: Plan): PlanChange[] {
  const changes: PlanChange[] = [];
  if (orig.title !== next.title) changes.push({ kind: 'retitled', id: '-', detail: `${orig.title} → ${next.title}` });
  const byId = new Map(orig.steps.map((s) => [s.id, s]));
  for (const s of next.steps) {
    const o = byId.get(s.id);
    if (!o) changes.push({ kind: 'added', id: s.id, detail: s.intent });
    else if (o.intent !== s.intent || o.expected !== s.expected) changes.push({ kind: 'edited', id: s.id });
    byId.delete(s.id);
  }
  for (const id of byId.keys()) changes.push({ kind: 'removed', id });
  const critById = new Map(orig.criteria.map((c) => [c.id, c.description]));
  for (const c of next.criteria) {
    const o = critById.get(c.id);
    if (o === undefined) changes.push({ kind: 'added', id: c.id, detail: c.description });
    else if (o !== c.description) changes.push({ kind: 'edited', id: c.id });
    critById.delete(c.id);
  }
  for (const id of critById.keys()) changes.push({ kind: 'removed', id });
  return changes;
}

/** Fields must be non-empty to satisfy the plan schema (min(1) strings). */
export function planProblems(plan: Plan): string[] {
  const problems: string[] = [];
  if (!plan.title.trim()) problems.push('title is empty');
  if (plan.title.length > 80) problems.push('title exceeds 80 chars');
  if (plan.steps.length < 1 || plan.steps.length > 30) problems.push('needs 1-30 steps');
  if (plan.criteria.length < 1 || plan.criteria.length > 15) problems.push('needs 1-15 criteria');
  for (const s of plan.steps) {
    if (!s.intent.trim()) problems.push(`${s.id}: intent is empty`);
    if (!s.expected.trim()) problems.push(`${s.id}: expected is empty`);
  }
  for (const c of plan.criteria) if (!c.description.trim()) problems.push(`${c.id}: description is empty`);
  return problems;
}
