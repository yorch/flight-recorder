import { badgeOf } from '../lib/status.ts';

export function StatusBadge({ status }: { status: string | null | undefined }) {
  const b = badgeOf(status);
  return <span className={`badge badge-${b.cls}`}>{b.text}</span>;
}
