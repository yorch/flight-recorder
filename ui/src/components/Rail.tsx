import type { RunRow } from '../lib/api.ts';
import type { Route } from '../lib/router.ts';
import { useRuns } from '../lib/runsStore.ts';
import { badgeOf, fmtAgo, isTerminalRow } from '../lib/status.ts';
import { Led } from './StatusBadge.tsx';

export const RECENT_LIMIT = 30;

/** Roster order used by the rail and by j/k: live runs first, then the most recent finished ones. */
export function rosterOf(runs: readonly RunRow[] | null): { live: RunRow[]; recent: RunRow[] } {
  const all = runs ?? [];
  return { live: all.filter((r) => !isTerminalRow(r)), recent: all.filter(isTerminalRow).slice(0, RECENT_LIMIT) };
}

function RosterItem({ r, current }: { r: RunRow; current: boolean }) {
  const b = badgeOf(r.status);
  return (
    <li>
      <a
        href={`#/run/${r.run_id}`}
        className="roster-item"
        aria-current={current ? 'page' : undefined}
        title={`${r.title ?? r.run_id} — ${b.text}`}
      >
        <Led value={b.cls} />
        <span className="roster-title">{r.title ?? r.run_id}</span>
        <span className="roster-meta">
          <span>{r.run_id.slice(-4)}</span>
          <span>{b.terminal ? fmtAgo(r.ended_at ?? r.started_at ?? r.submitted_at) : b.text}</span>
        </span>
      </a>
    </li>
  );
}

/** Left rail: brand, primary navigation, and a live roster of runs. */
export function Rail({ route, onHelp }: { route: Route; onHelp: () => void }) {
  const { runs, error, updatedAt } = useRuns();
  const { live, recent } = rosterOf(runs);
  const currentId = route.name === 'run' ? route.id : null;
  return (
    <aside className="rail" aria-label="Console">
      <a href="#/" className="brand">
        <span className="brand-mark" aria-hidden="true">
          <span />
        </span>
        <span className="brand-text">
          <strong>Flight Recorder</strong>
          <small>browser QA console</small>
        </span>
      </a>
      <nav className="rail-nav" aria-label="Main navigation">
        <a href="#/" aria-current={route.name === 'list' ? 'page' : undefined}>
          <span>Runs board</span>
          <kbd>g r</kbd>
        </a>
        <a href="#/new" aria-current={route.name === 'new' ? 'page' : undefined}>
          <span>New run</span>
          <kbd>n</kbd>
        </a>
      </nav>
      <section className="roster" aria-label="Run roster">
        <h2 className="rail-label">
          Live <span>{runs ? live.length : '—'}</span>
        </h2>
        {live.length === 0 ? (
          <p className="rail-empty">{runs ? 'No runs in flight.' : 'Connecting…'}</p>
        ) : (
          <ul>
            {live.map((r) => (
              <RosterItem key={r.run_id} r={r} current={r.run_id === currentId} />
            ))}
          </ul>
        )}
        <h2 className="rail-label">
          Recent <span>{runs ? recent.length : '—'}</span>
        </h2>
        {recent.length === 0 ? (
          <p className="rail-empty">{runs ? 'Nothing recorded yet.' : ''}</p>
        ) : (
          <ul>
            {recent.map((r) => (
              <RosterItem key={r.run_id} r={r} current={r.run_id === currentId} />
            ))}
          </ul>
        )}
      </section>
      <footer className="rail-foot">
        <span className="link-state" data-tone={error ? 'bad' : updatedAt ? 'ok' : 'idle'}>
          <span className="led" data-tone={error ? 'bad' : updatedAt ? 'ok' : 'idle'} aria-hidden="true" />
          {error ? 'control plane unreachable' : updatedAt ? 'control plane linked' : 'linking…'}
        </span>
        <button type="button" className="btn ghost small" onClick={onHelp}>
          Shortcuts <kbd>?</kbd>
        </button>
      </footer>
    </aside>
  );
}
