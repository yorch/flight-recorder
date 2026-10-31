import type { Report } from './api.ts';
import { screenshotUrl } from './api.ts';

export interface Shot {
  /** Artifact-relative reference ('screenshots/x.png' or a bare name). */
  ref: string;
  src: string;
  /** Owning group (plan step) for the lightbox caption. */
  group: string;
}

export interface ShotGroup {
  label: string;
  paths: string[];
}

/** Groups screenshots by owning plan step (report data) with a flat fallback. */
export function groupScreenshots(report: Report | null, names: string[]): ShotGroup[] {
  if (report?.plan) {
    const groups: ShotGroup[] = [];
    const seen = new Set<string>();
    for (const s of report.plan.steps) {
      if (s.screenshots.length) {
        groups.push({ label: `${s.id} — ${s.intent}`, paths: s.screenshots });
        for (const p of s.screenshots) seen.add(p);
      }
    }
    const rest = report.artifacts.screenshots.filter((p) => !seen.has(p));
    if (rest.length) groups.push({ label: 'other', paths: rest });
    return groups;
  }
  if (names.length) return [{ label: 'all', paths: names.map((n) => `screenshots/${n}`) }];
  return [];
}

/** One navigable sequence across all groups, in display order. */
export const flattenGroups = (runId: string, groups: ShotGroup[]): Shot[] =>
  groups.flatMap((g) => g.paths.map((ref) => ({ ref, src: screenshotUrl(runId, ref), group: g.label })));

/** Deduplicated shot list from arbitrary references (report evidence). */
export function shotsFromRefs(runId: string, refs: { ref: string; group: string }[]): Shot[] {
  const seen = new Set<string>();
  const out: Shot[] = [];
  for (const { ref, group } of refs) {
    const src = screenshotUrl(runId, ref);
    if (seen.has(src)) continue;
    seen.add(src);
    out.push({ ref, src, group });
  }
  return out;
}

/** Wrap-around navigation: stepIndex(0, -1, 5) === 4. */
export function stepIndex(i: number, delta: number, n: number): number {
  if (n <= 0) return 0;
  return (((i + delta) % n) + n) % n;
}

export const baseName = (ref: string): string => ref.split('/').pop() ?? ref;
