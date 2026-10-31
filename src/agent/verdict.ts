import type { RunStatus, Status } from '../events.ts';
import type { Evaluation, Plan } from './plan.ts';

export interface VerdictInput {
  claimed: Status;
  assertionFailed: boolean;
  /** null = spec.expect absent; otherwise one boolean per expectation. */
  expectResults: boolean[] | null;
  harnessError: boolean;
  budgetExceeded: boolean;
}

/** §6.4 verdict table. Budget overruns and harness errors are FAILED. */
export function computeVerdict(i: VerdictInput): RunStatus {
  if (i.harnessError || i.budgetExceeded) return 'FAILED';
  if (i.claimed === 'FAILED' || i.assertionFailed) return 'FAILED';
  if (i.expectResults === null) return 'UNVERIFIED';
  return i.expectResults.every(Boolean) ? 'PASSED' : 'FAILED';
}

/** §6.6 exit code: 0 passed, 1 failed, 2 harness/post-processing error, 3 unverified. */
export function exitCode(status: RunStatus, harnessError: boolean): 0 | 1 | 2 | 3 {
  if (harnessError) return 2;
  if (status === 'PASSED') return 0;
  if (status === 'UNVERIFIED') return 3;
  return 1;
}

export interface PlanVerdictInput {
  claimed: Status;
  harnessError: boolean;
  budgetExceeded: boolean;
  cancelled?: boolean;
  /** Every harness-executed assertion action (assert_* kinds), with its criterion claim. */
  assertions: { criterion: string | null; passed: boolean }[];
  /** Every step_done action the agent emitted. */
  stepDones: { plan_step: string; status: Status }[];
  plan: Plan;
  evaluation: Evaluation;
  /** null = spec.expect absent; otherwise one boolean per expectation. */
  expectResults: boolean[] | null;
}

/**
 * §15.5 verdict table for runs with a plan. A criterion is verified iff at least one
 * harness-executed assertion naming it PASSED *and* the evaluator marked it MET —
 * the evaluator can only downgrade.
 */
export function computePlanVerdict(i: PlanVerdictInput): RunStatus {
  if (i.cancelled) return 'CANCELLED';
  if (i.harnessError || i.budgetExceeded) return 'FAILED';
  if (i.assertions.some((a) => !a.passed)) return 'FAILED';
  if (i.stepDones.some((d) => d.status === 'FAILED')) return 'FAILED';
  if (i.claimed === 'FAILED') return 'FAILED';
  if (i.evaluation.criteria.some((c) => c.status === 'NOT_MET')) return 'FAILED';
  if (i.evaluation.issues.some((iss) => iss.severity === 'high')) return 'FAILED';
  const verified = (id: string) =>
    i.assertions.some((a) => a.criterion === id && a.passed) && i.evaluation.criteria.some((c) => c.id === id && c.status === 'MET');
  const stepsClosed = i.plan.steps.every((s) => i.stepDones.some((d) => d.plan_step === s.id && d.status === 'PASSED'));
  const criteriaVerified = i.plan.criteria.every((c) => verified(c.id));
  const expectsOk = i.expectResults === null || i.expectResults.every(Boolean);
  if (i.claimed === 'PASSED' && stepsClosed && criteriaVerified && expectsOk) return 'PASSED';
  return 'UNVERIFIED';
}

/** §6.6 exit code extended: CANCELLED = 4. */
export function exitCode15(status: RunStatus, harnessError: boolean): 0 | 1 | 2 | 3 | 4 {
  if (harnessError) return 2;
  if (status === 'PASSED') return 0;
  if (status === 'UNVERIFIED') return 3;
  if (status === 'CANCELLED') return 4;
  return 1;
}
