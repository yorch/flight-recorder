import { useMemo } from 'react';
import type { TimelineEvent } from '../lib/api.ts';
import { toneOf } from '../lib/status.ts';
import { useTableState } from '../lib/useTableState.ts';
import { type Column, DataTable } from './DataTable.tsx';
import { Panel } from './Panel.tsx';
import { Tag } from './StatusBadge.tsx';

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
      {
        key: 'kind',
        label: 'Kind',
        value: (e) => e.type,
        filter: 'select',
        className: 'mono',
        render: (e) => <span className={`ev-kind ev-${e.type.toLowerCase()}`}>{e.type}</span>,
      },
      { key: 'step', label: 'Step', value: (e) => e.step_id ?? e.plan_step ?? '', className: 'mono nowrap' },
      {
        key: 'label',
        label: 'Label',
        value: (e) => e.label ?? e.action ?? e.summary ?? e.test ?? '',
        filter: 'text',
        render: (e) => (
          <>
            {e.label ?? e.action ?? e.summary ?? e.test ?? ''}
            {e.error && <div className="cell-error mono">{e.error}</div>}
          </>
        ),
      },
      {
        key: 'status',
        label: 'Status',
        value: (e) => e.status,
        filter: 'select',
        render: (e) => e.status && <Tag value={e.status} />,
      },
    ],
    [t0],
  );
  if (rows.length === 0) return <p className="empty">No timeline events yet.</p>;
  return (
    <Panel
      title="Event timeline"
      testId="timeline"
      meta={rows.length > shown.length ? `last ${shown.length} of ${rows.length} events` : `${rows.length} events`}
    >
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
        rowClassName={(e) => (e.status ? `tone-row-${toneOf(e.status)}` : '')}
      />
    </Panel>
  );
}
