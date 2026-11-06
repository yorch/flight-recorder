import type { ReactNode } from 'react';
import { badgeOf, toneOf } from '../lib/status.ts';

/** Run-status mark: square LED + mono label, coloured by the shared tone language. */
export function StatusBadge({ status, testId, size }: { status: string | null | undefined; testId?: string; size?: 'lg' }) {
  const b = badgeOf(status);
  return (
    <span className={`tag badge badge-${b.cls}${size ? ` tag-${size}` : ''}`} data-tone={toneOf(b.cls)} data-testid={testId}>
      {b.text}
    </span>
  );
}

/** Any other status-like value (plan-step outcome, criterion verdict, HTTP class, event status). */
export function Tag({ value, tone, children }: { value: string; tone?: string; children?: ReactNode }) {
  return (
    <span className="tag" data-tone={tone ?? toneOf(value)}>
      {children ?? value.replaceAll('_', ' ')}
    </span>
  );
}

/** Bare LED dot (roster rows, plan track, outcome strip). */
export const Led = ({ value }: { value: string | null | undefined }) => (
  <span className="led" data-tone={toneOf(value)} aria-hidden="true" />
);
