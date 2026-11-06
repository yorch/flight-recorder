// Run-detail panels. The active one lives in the hash query (`?tab=network`) so
// a view is shareable; the default (overview) is omitted from the URL.
export const RUN_TABS = ['overview', 'evidence', 'timeline', 'network', 'artifacts'] as const;
export type RunTab = (typeof RUN_TABS)[number];

export const tabOf = (raw: string | null): RunTab => ((RUN_TABS as readonly string[]).includes(raw ?? '') ? (raw as RunTab) : 'overview');

export function withTab(params: URLSearchParams, tab: RunTab): URLSearchParams {
  const next = new URLSearchParams(params);
  if (tab === 'overview') next.delete('tab');
  else next.set('tab', tab);
  return next;
}
