import { type CSSProperties, useMemo, useState } from 'react';
import type { Report } from '../lib/api.ts';
import { baseName, flattenGroups, groupScreenshots } from '../lib/gallery.ts';
import { Lightbox } from './Lightbox.tsx';
import { Panel } from './Panel.tsx';
import { Tag } from './StatusBadge.tsx';

export { groupScreenshots } from '../lib/gallery.ts';

/** §16.3 screenshot gallery grouped by plan step, with a navigable lightbox. */
export function Gallery({ runId, report, names }: { runId: string; report: Report | null; names: string[] }) {
  const [index, setIndex] = useState<number | null>(null);
  const groups = useMemo(() => groupScreenshots(report, names), [report, names]);
  const shots = useMemo(() => flattenGroups(runId, groups), [runId, groups]);
  const outcomes = useMemo(() => new Map((report?.plan?.steps ?? []).map((s) => [`${s.id} — ${s.intent}`, s.outcome])), [report]);
  if (groups.length === 0) return <p className="empty">No screenshots captured yet.</p>;
  let n = 0;
  return (
    <Panel title="Screenshots" testId="gallery" className="gallery-panel" meta={`${shots.length} frames · ${groups.length} groups`}>
      {groups.map((g) => {
        const outcome = outcomes.get(g.label);
        return (
          <div key={g.label} className="shot-group" style={{ '--n': Math.min(g.paths.length, 4) } as CSSProperties}>
            <h3 className="shot-group-head" title={g.label}>
              <span className="shot-group-label">{g.label}</span>
              {outcome && <Tag value={outcome} />}
              <span className="mono cell-sub">{g.paths.length}</span>
            </h3>
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
                    {/* Eager: the gallery lives in a tab panel that may be hidden; lazy images there never load. */}
                    <img src={shots[at]?.src} alt={p} loading="eager" decoding="async" />
                    <span className="thumb-index mono">{String(at + 1).padStart(2, '0')}</span>
                    <span className="thumb-name mono">{baseName(p)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <Lightbox shots={shots} index={index} onIndex={setIndex} />
    </Panel>
  );
}
