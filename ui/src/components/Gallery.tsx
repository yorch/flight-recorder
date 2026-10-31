import { useState } from 'react';
import type { Report } from '../lib/api.ts';
import { screenshotUrl } from '../lib/api.ts';

interface Group {
  label: string;
  paths: string[];
}

/** Groups screenshots by owning plan step (report data) with a flat fallback. */
export function groupScreenshots(report: Report | null, names: string[]): Group[] {
  if (report?.plan) {
    const groups: Group[] = [];
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

export function Gallery({ runId, report, names }: { runId: string; report: Report | null; names: string[] }) {
  const [lightbox, setLightbox] = useState<string | null>(null);
  const groups = groupScreenshots(report, names);
  if (groups.length === 0) return null;
  return (
    <section className="panel" data-testid="gallery">
      <h3>Screenshots</h3>
      {groups.map((g) => (
        <div key={g.label}>
          <h4 className="muted">{g.label}</h4>
          <div className="gallery">
            {g.paths.map((p) => (
              <button key={p} type="button" className="thumb" onClick={() => setLightbox(screenshotUrl(runId, p))}>
                <img src={screenshotUrl(runId, p)} alt={p} loading="lazy" />
              </button>
            ))}
          </div>
        </div>
      ))}
      {lightbox && (
        <button type="button" className="lightbox" onClick={() => setLightbox(null)} aria-label="close lightbox">
          <img src={lightbox} alt="screenshot" />
        </button>
      )}
    </section>
  );
}
