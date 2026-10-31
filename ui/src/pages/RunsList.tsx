import { useCallback, useEffect, useRef, useState } from 'react';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { apiGet, type RunRow } from '../lib/api.ts';
import { FILTERABLE, fmtDateTime, fmtDuration, isTerminalRow, matchesFilter } from '../lib/status.ts';

export function RunsList() {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<string>('all');
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const { runs } = await apiGet<{ runs: RunRow[] }>('/api/runs');
      setRuns(runs);
      setError(null);
      return runs;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  // Auto-refresh every 2 s while any run is non-terminal (§16.3).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const rows = await load();
      if (cancelled) return;
      timer.current = window.setTimeout(tick, rows?.some((r) => !isTerminalRow(r)) ? 2000 : 5000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [load]);

  const visible = (runs ?? []).filter(
    (r) => matchesFilter(r, filter) && `${r.title ?? ''} ${r.run_id} ${r.model ?? ''}`.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <section>
      <div className="row spread">
        <div>
          <p className="eyebrow">Execution workspace</p>
          <h2>Test runs</h2>
          <p className="muted">Monitor agents, review evidence, and investigate outcomes.</p>
        </div>
        <div className="row">
          <label htmlFor="status-filter">Status</label>
          <select id="status-filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
            {FILTERABLE.map((f) => (
              <option key={f} value={f}>
                {f.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
          <a className="btn primary" href="#/new">
            New run
          </a>
        </div>
      </div>
      <div className="stats">
        <div>
          <span>Total runs</span>
          <strong>{runs?.length ?? '—'}</strong>
        </div>
        <div>
          <span>In progress</span>
          <strong>{runs ? runs.filter((r) => !isTerminalRow(r)).length : '—'}</strong>
        </div>
        <div>
          <span>Passed</span>
          <strong>{runs ? runs.filter((r) => r.status.toLowerCase() === 'passed').length : '—'}</strong>
        </div>
        <div>
          <span>Needs attention</span>
          <strong>
            {runs ? runs.filter((r) => ['failed', 'unverified', 'awaiting_approval'].includes(r.status.toLowerCase())).length : '—'}
          </strong>
        </div>
      </div>
      <div className="toolbar">
        <input
          type="search"
          aria-label="Search runs"
          placeholder="Search title, run ID, or model…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="muted small">{visible.length} runs · auto-refresh enabled</span>
        <button type="button" className="btn" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      {runs === null && !error && (
        <div className="empty-state" role="status">
          Loading runs…
        </div>
      )}
      {runs !== null && visible.length === 0 && (
        <div className="empty-state">
          <h3>{runs.length ? 'No matching runs' : 'Your first test starts here'}</h3>
          <p className="muted">
            {runs.length ? 'Try another search or status filter.' : 'Give an agent a goal and collect a complete record of the result.'}
          </p>
          <a className="btn" href="#/new">
            Create a run
          </a>
        </div>
      )}
      {visible.length > 0 && (
        <div className="table-wrap">
          <table className="runs">
            <thead>
              <tr>
                <th>Status</th>
                <th>Title</th>
                <th>Model</th>
                <th>Created</th>
                <th>Duration</th>
                <th>Steps</th>
                <th>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.run_id}>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td>
                    <a href={`#/run/${r.run_id}`}>{r.title ?? r.run_id}</a>
                    <div className="muted small">{r.run_id}</div>
                  </td>
                  <td className="mono">{r.model ?? '—'}</td>
                  <td className="mono">{fmtDateTime(r.started_at ?? r.submitted_at)}</td>
                  <td className="mono">{fmtDuration(r.started_at ?? r.submitted_at, r.ended_at)}</td>
                  <td className="mono">{r.steps ?? '—'}</td>
                  <td className="mono">{r.tokens ? `${r.tokens.input ?? 0}/${r.tokens.output ?? 0}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
