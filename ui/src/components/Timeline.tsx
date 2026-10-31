import { useMemo } from 'react';
import type { TimelineEvent } from '../lib/api.ts';
import { useTableState } from '../lib/useTableState.ts';
import { type Column, DataTable } from './DataTable.tsx';

const ROW_TYPES = new Set([
  'RUN_START',
  'RECORDING_START',
  'THINKING_START',
  'THINKING_END',
  'ACTION_START',
  'ACTION_END',
  'RECORDING_STOP',
  'RUN_END',
]);

export const timelineRows = (events: TimelineEvent[]): TimelineEvent[] => events.filter((e) => ROW_TYPES.has(e.type));

const haystack = (e: TimelineEvent) =>
  `${e.type} ${e.step_id ?? ''} ${e.plan_step ?? ''} ${e.label ?? e.action ?? e.summary ?? ''} ${e.status ?? ''} ${e.error ?? ''}`;

export function Timeline({ events, maxRows }: { events: TimelineEvent[]; maxRows?: number }) {
  const [state, setState] = useTableState('tl');
  const rows = useMemo(() => timelineRows(events), [events]);
  const t0 = rows[0]?.t_ms ?? 0;
  const shown = useMemo(() => (maxRows === undefined ? rows : rows.slice(-maxRows)), [rows, maxRows]);
  const columns = useMemo<Column<TimelineEvent>[]>(
    () => [
      {
        key: 't',
        label: 't',
        value: (e) => e.t_ms,
        className: 'mono num',
        render: (e) => `${((e.t_ms - t0) / 1000).toFixed(1)}s`,
        searchable: false,
      },
      { key: 'kind', label: 'Kind', value: (e) => e.type, filter: 'select', className: 'mono small' },
      { key: 'step', label: 'Step', value: (e) => e.step_id ?? e.plan_step ?? '', className: 'mono' },
      {
        key: 'label',
        label: 'Label',
        value: (e) => e.label ?? e.action ?? e.summary ?? e.test ?? '',
        filter: 'text',
        render: (e) => (
          <>
            {e.label ?? e.action ?? e.summary ?? e.test ?? ''}
            {e.error && <div className="warn small">{e.error}</div>}
          </>
        ),
      },
      {
        key: 'status',
        label: 'Status',
        value: (e) => e.status,
        filter: 'select',
        render: (e) => e.status && <span className={`chip chip-${e.status.toLowerCase()}`}>{e.status}</span>,
      },
    ],
    [t0],
  );
  if (rows.length === 0) return null;
  return (
    <section className="panel" data-testid="timeline">
      <h3>Timeline</h3>
      {rows.length > shown.length && (
        <p className="muted small">
          last {shown.length} of {rows.length} events
        </p>
      )}
      <DataTable
        label="Event timeline"
        noun="events"
        search="Search events…"
        columns={columns}
        rows={shown}
        rowKey={(e) => e.seq}
        state={state}
        onState={setState}
        haystack={haystack}
      />
    </section>
  );
}
