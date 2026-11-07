import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import type { Evaluation, Plan } from '../../src/agent/plan.ts';
import { parsePlan } from '../../src/agent/plan.ts';
import { computePlanVerdict, type PlanVerdictInput } from '../../src/agent/verdict.ts';

const plan: Plan = {
  title: 't',
  steps: [
    { id: 'p1', intent: 'a', expected: 'e' },
    { id: 'p2', intent: 'b', expected: 'e' },
  ],
  criteria: [{ id: 'c1', description: 'c' }],
};
const evalOk: Evaluation = { criteria: [{ id: 'c1', status: 'MET', evidence: 'e', screenshots: [] }], issues: [], conclusions: 'ok' };
const base: PlanVerdictInput = {
  claimed: 'PASSED' as const,
  harnessError: false,
  budgetExceeded: false,
  assertions: [{ criterion: 'c1', passed: true }],
  stepDones: [
    { plan_step: 'p1', status: 'PASSED' as const },
    { plan_step: 'p2', status: 'PASSED' as const },
  ],
  plan,
  evaluation: evalOk,
  expectResults: null,
};

describe('computePlanVerdict (§15.5 table)', () => {
  const rows: [string, Partial<typeof base>, string][] = [
    ['all green -> PASSED', {}, 'PASSED'],
    ['harness error -> FAILED', { harnessError: true }, 'FAILED'],
    ['budget exceeded -> FAILED', { budgetExceeded: true }, 'FAILED'],
    ['cancelled -> CANCELLED', { cancelled: true }, 'CANCELLED'],
    ['cancelled beats everything', { cancelled: true, harnessError: true }, 'CANCELLED'],
    ['failed assertion -> FAILED', { assertions: [{ criterion: 'c1', passed: false }] }, 'FAILED'],
    ['step_done FAILED -> FAILED', { stepDones: [...base.stepDones.slice(0, 1), { plan_step: 'p2', status: 'FAILED' }] }, 'FAILED'],
    ['claimed FAILED -> FAILED', { claimed: 'FAILED' }, 'FAILED'],
    [
      'NOT_MET -> FAILED',
      { evaluation: { ...evalOk, criteria: [{ id: 'c1', status: 'NOT_MET', evidence: '', screenshots: [] }] } },
      'FAILED',
    ],
    [
      'high issue -> FAILED',
      { evaluation: { ...evalOk, issues: [{ severity: 'high', title: 't', description: 'd', plan_step: null, screenshot: null }] } },
      'FAILED',
    ],
    [
      'medium issue does not fail',
      { evaluation: { ...evalOk, issues: [{ severity: 'medium', title: 't', description: 'd', plan_step: null, screenshot: null }] } },
      'PASSED',
    ],
    ['MET but no assertion -> UNVERIFIED', { assertions: [] }, 'UNVERIFIED'],
    [
      'assertion but UNCLEAR -> UNVERIFIED',
      { evaluation: { ...evalOk, criteria: [{ id: 'c1', status: 'UNCLEAR', evidence: '', screenshots: [] }] } },
      'UNVERIFIED',
    ],
    ['assertion for another criterion only -> UNVERIFIED', { assertions: [{ criterion: 'c9', passed: true }] }, 'UNVERIFIED'],
    ['missing step_done -> UNVERIFIED', { stepDones: [{ plan_step: 'p1', status: 'PASSED' }] }, 'UNVERIFIED'],
    ['expect failing -> UNVERIFIED', { expectResults: [true, false] }, 'UNVERIFIED'],
    ['expect passing -> PASSED', { expectResults: [true, true] }, 'PASSED'],
  ];
  for (const [name, over, want] of rows) {
    it(name, () => assert.equal(computePlanVerdict({ ...base, ...over }), want));
  }
});

describe('parsePlan (§15.2 limits)', () => {
  it('rejects duplicate step ids and >30 steps', () => {
    assert.throws(() => parsePlan({ title: 't', steps: [plan.steps[0], plan.steps[0]], criteria: plan.criteria }), /duplicate/);
    assert.throws(() =>
      parsePlan({
        title: 't',
        steps: Array.from({ length: 31 }, (_, i) => ({ id: `p${i + 1}`, intent: 'a', expected: 'b' })),
        criteria: plan.criteria,
      }),
    );
    assert.throws(() => parsePlan({ title: 't', steps: [{ id: 'x1', intent: 'a', expected: 'b' }], criteria: plan.criteria }));
    assert.throws(() => parsePlan({ title: 't', steps: plan.steps, criteria: [] }));
  });
});
