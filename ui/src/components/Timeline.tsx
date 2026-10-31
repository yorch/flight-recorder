import type { TimelineEvent } from '../lib/api.ts';

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

export function Timeline({ events, maxRows }: { events: TimelineEvent[]; maxRows?: number }) {
  const rows = events.filter((e) => ROW_TYPES.has(e.type));
  if (rows.length === 0) return null;
  const shown = maxRows === undefined ? rows : rows.slice(-maxRows);
  const t0 = rows[0]?.t_ms ?? 0;
  return (
    <section className="panel" data-testid="timeline">
      <h3>Timeline</h3>
      {rows.length > shown.length && (
        <p className="muted small">
          last {shown.length} of {rows.length} events
        </p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>t</th>
              <th>Kind</th>
              <th>Step</th>
              <th>Label</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.seq}>
                <td className="mono">{((e.t_ms - t0) / 1000).toFixed(1)}s</td>
                <td className="mono small">{e.type}</td>
                <td className="mono">{e.step_id ?? e.plan_step ?? ''}</td>
                <td>
                  {e.label ?? e.action ?? e.summary ?? e.test ?? ''}
                  {e.error && <div className="warn small">{e.error}</div>}
                </td>
                <td>{e.status && <span className={`chip chip-${e.status.toLowerCase()}`}>{e.status}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
