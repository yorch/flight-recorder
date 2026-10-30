import type { RunStatus, Status } from '../events.ts';

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
