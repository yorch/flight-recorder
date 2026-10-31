import { useMemo, useState } from 'react';
import type { Report } from '../lib/api.ts';
import { baseName, flattenGroups, groupScreenshots } from '../lib/gallery.ts';
import { Lightbox } from './Lightbox.tsx';

export { groupScreenshots } from '../lib/gallery.ts';

/** §16.3 screenshot gallery grouped by plan step, with a navigable lightbox. */
export function Gallery({ runId, report, names }: { runId: string; report: Report | null; names: string[] }) {
  const [index, setIndex] = useState<number | null>(null);
  const groups = useMemo(() => groupScreenshots(report, names), [report, names]);
  const shots = useMemo(() => flattenGroups(runId, groups), [runId, groups]);
  if (groups.length === 0) return null;
  let n = 0;
  return (
    <section className="panel" data-testid="gallery">
      <div className="row spread">
        <h3>Screenshots</h3>
        <span className="muted small">{shots.length} captured</span>
      </div>
      {groups.map((g) => (
        <div key={g.label}>
          <h4 className="muted">{g.label}</h4>
          <div className="gallery">
            {g.paths.map((p) => {
              const at = n++;
              return (
                <button
                  key={p}
                  type="button"
                  className="thumb"
                  aria-label={`Open screenshot ${at + 1} of ${shots.length}: ${baseName(p)}`}
                  onClick={(e) => {
                    e.currentTarget.focus();
                    setIndex(at);
                  }}
                >
                  <img src={shots[at]?.src} alt={p} loading="lazy" />
                  <span className="thumb-index mono">{at + 1}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <Lightbox shots={shots} index={index} onIndex={setIndex} />
    </section>
  );
}
