import { useMemo } from 'react';
import type { LiveProgress as LiveProgressData, LiveStepEntry } from '../lib/api.ts';
import { useTableState } from '../lib/useTableState.ts';
import { type Column, DataTable } from './DataTable.tsx';

const STEP_COLUMNS: Column<LiveStepEntry>[] = [
  { key: 'step', label: 'Step', value: (s) => s.step_id, className: 'mono' },
  { key: 'kind', label: 'Kind', value: (s) => s.kind, filter: 'select', className: 'mono small' },
  {
    key: 'label',
    label: 'Label',
    value: (s) => s.label,
    render: (s) => (
      <>
        {s.label}
        {s.plan_step && <span className="muted small"> · {s.plan_step}</span>}
        {s.error && <div className="warn small">{s.error}</div>}
      </>
    ),
  },
  {
    key: 'result',
    label: 'Result',
    value: (s) => s.result,
    filter: 'select',
    render: (s) => <span className={`chip chip-${s.result}`}>{s.result}</span>,
  },
];

const fmtElapsed = (s: number | null | undefined): string => {
  if (s === null || s === undefined) return '—';
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s - m * 60).padStart(2, '0')}s` : `${s}s`;
};

/**
 * §16.3 live progress panel: current phase + plan step, per-plan-step statuses,
 * the rolling agent step log (newest first) and elapsed/steps/token counters.
 * Driven by SSE `progress` events; shown only while the run is non-terminal.
 */
export function LiveProgress({ progress, fallbackPhase }: { progress: LiveProgressData | null; fallbackPhase: string | null }) {
  const phase = progress?.phase ?? fallbackPhase ?? 'submitted';
  const counters = progress?.counters;
  const planSteps = progress?.plan_steps ?? [];
  const steps = progress?.steps;
  // Newest first by default; header clicks re-sort, local state (not shared in the URL).
  const newestFirst = useMemo(() => [...(steps ?? [])].reverse(), [steps]);
  const [state, setState] = useTableState(null);
  return (
    <section className="panel" data-testid="live-progress">
      <div className="row spread">
        <h3>Live progress</h3>
        <span className={`chip chip-${phase === 'running' ? 'running' : 'open'}`} data-testid="live-phase">
          {phase.replaceAll('_', ' ')}
          {progress?.plan_step ? ` · step ${progress.plan_step}` : ''}
        </span>
      </div>
      <div className="live-counters" data-testid="live-counters">
        <div>
          <span>Elapsed</span>
          <strong data-testid="counter-elapsed">{fmtElapsed(counters?.elapsed_s)}</strong>
        </div>
        <div>
          <span>Steps</span>
          <strong data-testid="counter-steps">{counters?.steps ?? 0}</strong>
        </div>
        <div>
          <span>Model tokens</span>
          <strong data-testid="counter-tokens">{counters ? `${counters.tokens.input} / ${counters.tokens.output}` : '—'}</strong>
        </div>
        <div>
          <span>Events</span>
          <strong data-testid="counter-events">{progress?.events ?? 0}</strong>
        </div>
      </div>
      {planSteps.length > 0 && (
        <ul className="plan-step-statuses" data-testid="plan-step-statuses">
          {planSteps.map((s) => (
            <li key={s.id}>
              <span className="mono">{s.id}</span> <span className={`chip chip-${s.status}`}>{s.status}</span>
            </li>
          ))}
        </ul>
      )}
      <DataTable
        label="Agent step log"
        noun="steps"
        columns={STEP_COLUMNS}
        rows={newestFirst}
        rowKey={(s) => s.step_id}
        state={state}
        onState={setState}
        testId="step-log"
        wrapClassName="step-log"
        rowClassName={(s) => (s.result === 'running' ? 'current' : '')}
        empty="Waiting for the first agent step…"
      />
    </section>
  );
}
