import { useCallback, useEffect, useRef, useState } from 'react';
import { type Column, DataTable } from '../components/DataTable.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { apiGet, type RunRow } from '../lib/api.ts';
import { badgeOf, durationMs, fmtDateTime, fmtDuration, isTerminalRow, matchesStatus, statusLabel } from '../lib/status.ts';
import { emptyState, type TableState } from '../lib/table.ts';
import { useTableState } from '../lib/useTableState.ts';

const created = (r: RunRow) => r.started_at ?? r.submitted_at;
const tsOf = (iso: string | null) => (iso ? Date.parse(iso) : null);

export const RUN_COLUMNS: Column<RunRow>[] = [
  {
    key: 'status',
    label: 'Status',
    value: (r) => badgeOf(r.status).cls,
    facet: (r) => badgeOf(r.status).cls,
    facetLabel: statusLabel,
    filter: 'select',
    matches: (r, want) => matchesStatus(r.status, want),
    render: (r) => <StatusBadge status={r.status} />,
  },
  {
    key: 'title',
    label: 'Title',
    value: (r) => r.title ?? r.run_id,
    filter: 'text',
    render: (r) => (
      <>
        <a href={`#/run/${r.run_id}`}>{r.title ?? r.run_id}</a>
        <div className="muted small">{r.run_id}</div>
      </>
    ),
  },
  { key: 'model', label: 'Model', value: (r) => r.model, filter: 'select', className: 'mono' },
  {
    key: 'created',
    label: 'Created',
    value: (r) => tsOf(created(r)),
    className: 'mono',
    searchable: false,
    render: (r) => fmtDateTime(created(r)),
  },
  {
    key: 'duration',
    label: 'Duration',
    value: (r) => durationMs(created(r), r.ended_at),
    className: 'mono num',
    searchable: false,
    render: (r) => fmtDuration(created(r), r.ended_at),
  },
  { key: 'steps', label: 'Steps', value: (r) => r.steps, className: 'mono num', searchable: false, render: (r) => r.steps ?? '—' },
  {
    key: 'tokens',
    label: 'Tokens',
    value: (r) => (r.tokens ? (r.tokens.input ?? 0) + (r.tokens.output ?? 0) : null),
    className: 'mono num',
    searchable: false,
    render: (r) => (r.tokens ? `${r.tokens.input ?? 0}/${r.tokens.output ?? 0}` : '—'),
  },
];

const haystack = (r: RunRow) => `${r.title ?? ''} ${r.run_id} ${r.model ?? ''} ${r.status} ${r.summary ?? ''}`;

export function RunsList() {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useTableState('');
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

  const statusFilter = (status: string | null): TableState => ({ ...emptyState(), sort: state.sort, filters: status ? { status } : {} });
  const count = (pred: (r: RunRow) => boolean) => (runs ? runs.filter(pred).length : '—');
  const stats: { label: string; value: number | string; filter: string | null }[] = [
    { label: 'Total runs', value: runs?.length ?? '—', filter: null },
    { label: 'In progress', value: count((r) => matchesStatus(r.status, 'active')), filter: 'active' },
    { label: 'Passed', value: count((r) => matchesStatus(r.status, 'passed')), filter: 'passed' },
    { label: 'Needs attention', value: count((r) => matchesStatus(r.status, 'attention')), filter: 'attention' },
  ];

  return (
    <section>
      <div className="row spread">
        <div>
          <p className="eyebrow">Execution workspace</p>
          <h2>Test runs</h2>
          <p className="muted">Monitor agents, review evidence, and investigate outcomes.</p>
        </div>
        <a className="btn primary" href="#/new">
          New run
        </a>
      </div>
      <div className="stats">
        {stats.map((s) => {
          const active = (state.filters.status ?? null) === s.filter && !state.q;
          return (
            <button key={s.label} type="button" className="stat" aria-pressed={active} onClick={() => setState(statusFilter(s.filter))}>
              <span>{s.label}</span>
              <strong>{s.value}</strong>
            </button>
          );
        })}
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
      {runs !== null && runs.length === 0 && (
        <div className="empty-state">
          <h3>Your first test starts here</h3>
          <p className="muted">Give an agent a goal and collect a complete record of the result.</p>
          <a className="btn" href="#/new">
            Create a run
          </a>
        </div>
      )}
      {runs !== null && runs.length > 0 && (
        <DataTable
          label="Test runs"
          noun="runs"
          search="Search title, run ID, model, or status…"
          columns={RUN_COLUMNS}
          rows={runs}
          rowKey={(r) => r.run_id}
          state={state}
          onState={setState}
          haystack={haystack}
          className="runs"
          testId="runs-table"
          toolbarExtra={
            <>
              <span className="muted small">auto-refresh enabled</span>
              <button type="button" className="btn" onClick={() => void load()}>
                Refresh
              </button>
            </>
          }
        />
      )}
    </section>
  );
}
