import { type Column, DataTable } from '../components/DataTable.tsx';
import { Banner } from '../components/Panel.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import type { RunRow } from '../lib/api.ts';
import { refreshRuns, useRuns } from '../lib/runsStore.ts';
import { badgeOf, durationMs, fmtCount, fmtDateTime, fmtDuration, matchesStatus, statusLabel, toneOf } from '../lib/status.ts';
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
    className: 'col-title',
    render: (r) => (
      <>
        <a href={`#/run/${r.run_id}`}>{r.title ?? r.run_id}</a>
        <div className="cell-sub mono">
          {r.run_id}
          {r.summary && <span className="cell-summary"> · {r.summary}</span>}
        </div>
      </>
    ),
  },
  { key: 'model', label: 'Model', value: (r) => r.model, filter: 'select', className: 'mono' },
  {
    key: 'created',
    label: 'Created',
    value: (r) => tsOf(created(r)),
    className: 'mono nowrap',
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
    render: (r) => (r.tokens ? `${fmtCount(r.tokens.input ?? 0)} / ${fmtCount(r.tokens.output ?? 0)}` : '—'),
  },
];

const haystack = (r: RunRow) => `${r.title ?? ''} ${r.run_id} ${r.model ?? ''} ${r.status} ${r.summary ?? ''}`;

const STRIP = 48;

/** The last N runs as a row of LEDs, oldest left — a quick read of recent stability. */
function OutcomeStrip({ runs }: { runs: RunRow[] }) {
  const shown = runs.slice(0, STRIP).reverse();
  return (
    <div className="outcome-strip" data-testid="outcome-strip">
      <span className="kpi-label">Last {shown.length} runs</span>
      <ol>
        {shown.map((r) => {
          const b = badgeOf(r.status);
          return (
            <li key={r.run_id}>
              <a href={`#/run/${r.run_id}`} data-tone={toneOf(b.cls)} title={`${r.title ?? r.run_id} — ${b.text}`}>
                <span className="sr-only">
                  {r.title ?? r.run_id}: {b.text}
                </span>
              </a>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** §16.3 runs board: KPI tiles (status-group filters), outcome strip, sortable/filterable table. */
export function RunsList() {
  const { runs, error, updatedAt } = useRuns();
  const [state, setState] = useTableState('');

  const statusFilter = (status: string | null): TableState => ({ ...emptyState(), sort: state.sort, filters: status ? { status } : {} });
  const count = (pred: (r: RunRow) => boolean) => (runs ? runs.filter(pred).length : null);
  const passed = count((r) => matchesStatus(r.status, 'passed'));
  const failed = count((r) => matchesStatus(r.status, 'failed'));
  const decided = (passed ?? 0) + (failed ?? 0);
  const stats: { label: string; value: number | null; filter: string | null; tone: string }[] = [
    { label: 'Total runs', value: runs?.length ?? null, filter: null, tone: 'idle' },
    { label: 'In progress', value: count((r) => matchesStatus(r.status, 'active')), filter: 'active', tone: 'live' },
    { label: 'Passed', value: passed, filter: 'passed', tone: 'ok' },
    { label: 'Failed', value: failed, filter: 'failed', tone: 'bad' },
    { label: 'Needs attention', value: count((r) => matchesStatus(r.status, 'attention')), filter: 'attention', tone: 'warn' },
  ];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Runs board</p>
          <h1>Test runs</h1>
          <p className="lede">Every agent run, its verdict and the evidence behind it.</p>
        </div>
        <a className="btn primary" href="#/new">
          New run <kbd>n</kbd>
        </a>
      </header>

      <div className="kpis">
        {stats.map((s) => {
          const active = (state.filters.status ?? null) === s.filter && !state.q;
          return (
            <button
              key={s.label}
              type="button"
              className="kpi"
              data-tone={s.tone}
              aria-pressed={active}
              onClick={() => setState(statusFilter(s.filter))}
            >
              <span className="kpi-label">{s.label}</span>
              <strong className="kpi-value">{s.value ?? '—'}</strong>
            </button>
          );
        })}
        <div className="kpi kpi-static">
          <span className="kpi-label">Pass rate</span>
          <strong className="kpi-value">{decided > 0 ? `${Math.round(((passed ?? 0) / decided) * 100)}%` : '—'}</strong>
          <span className="kpi-sub">of passed + failed</span>
        </div>
      </div>
      {runs && runs.length > 0 && <OutcomeStrip runs={runs} />}

      {error && <Banner tone="bad">{error}</Banner>}
      {runs === null && !error && (
        <div className="empty" role="status">
          Loading runs…
        </div>
      )}
      {runs !== null && runs.length === 0 && (
        <div className="empty">
          <h2>No runs recorded yet</h2>
          <p>Give an agent a goal; the recorder captures video, screenshots, timeline and network for the verdict.</p>
          <a className="btn primary" href="#/new">
            Create a run
          </a>
        </div>
      )}
      {runs !== null && runs.length > 0 && (
        <DataTable
          label="Test runs"
          noun="runs"
          search="Search title, run ID, model, status…"
          columns={RUN_COLUMNS}
          rows={runs}
          rowKey={(r) => r.run_id}
          state={state}
          onState={setState}
          haystack={haystack}
          className="runs"
          testId="runs-table"
          rowClassName={(r) => `tone-row-${toneOf(badgeOf(r.status).cls)}`}
          toolbarExtra={
            <>
              <span className="toolbar-note mono">
                {updatedAt ? `synced ${new Date(updatedAt).toISOString().slice(11, 19)}Z` : ''} · auto-refresh
              </span>
              <button type="button" className="btn small" onClick={() => void refreshRuns()}>
                Refresh
              </button>
            </>
          }
        />
      )}
    </div>
  );
}
