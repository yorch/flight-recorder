import { useMemo } from 'react';
import type { LiveProgress as LiveProgressData, LiveStepEntry, Plan } from '../lib/api.ts';
import { artifactUrl } from '../lib/api.ts';
import { fmtElapsed, toneOf } from '../lib/status.ts';
import { useTableState } from '../lib/useTableState.ts';
import { type Column, DataTable } from './DataTable.tsx';
import { Panel } from './Panel.tsx';
import { Led, Tag } from './StatusBadge.tsx';

const STEP_COLUMNS: Column<LiveStepEntry>[] = [
  { key: 'step', label: 'Step', value: (s) => s.step_id, className: 'mono nowrap' },
  { key: 'kind', label: 'Kind', value: (s) => s.kind, filter: 'select', className: 'mono' },
  {
    key: 'label',
    label: 'Label',
    value: (s) => s.label,
    render: (s) => (
      <>
        {s.label}
        {s.plan_step && <span className="cell-sub mono"> · {s.plan_step}</span>}
        {s.error && <div className="cell-error mono">{s.error}</div>}
      </>
    ),
  },
  { key: 'result', label: 'Result', value: (s) => s.result, filter: 'select', render: (s) => <Tag value={s.result} /> },
];

/**
 * §16.3 live telemetry: phase + plan step, counters, and the plan track
 * (per-plan-step statuses, with intents when the plan is known). SSE-driven.
 */
export function LiveProgress({
  progress,
  fallbackPhase,
  plan,
}: {
  progress: LiveProgressData | null;
  fallbackPhase: string | null;
  plan?: Plan | null;
}) {
  const phase = progress?.phase ?? fallbackPhase ?? 'submitted';
  const counters = progress?.counters;
  const planSteps = progress?.plan_steps ?? [];
  const intents = new Map((plan?.steps ?? []).map((s) => [s.id, s.intent]));
  const done = planSteps.filter((s) => toneOf(s.status) === 'ok').length;
  return (
    <Panel
      title="Live telemetry"
      testId="live-progress"
      className="telemetry-panel"
      meta={
        <span className="tag" data-tone={toneOf(phase)} data-testid="live-phase">
          {phase.replaceAll('_', ' ')}
          {progress?.plan_step ? ` · step ${progress.plan_step}` : ''}
        </span>
      }
    >
      <div className="gauges" data-testid="live-counters">
        <div className="gauge">
          <span>Elapsed</span>
          <strong data-testid="counter-elapsed">{fmtElapsed(counters?.elapsed_s)}</strong>
        </div>
        <div className="gauge">
          <span>Steps</span>
          <strong data-testid="counter-steps">{counters?.steps ?? 0}</strong>
        </div>
        <div className="gauge">
          <span>Tokens in / out</span>
          <strong data-testid="counter-tokens" title={counters ? `${counters.tokens.input} / ${counters.tokens.output}` : undefined}>
            {counters ? `${counters.tokens.input} / ${counters.tokens.output}` : '—'}
          </strong>
        </div>
        <div className="gauge">
          <span>Events</span>
          <strong data-testid="counter-events">{progress?.events ?? 0}</strong>
        </div>
      </div>
      {planSteps.length > 0 && (
        <>
          <div className="track-head">
            <span>Plan track</span>
            <span className="mono">
              {done}/{planSteps.length} done
            </span>
          </div>
          <div className="track-bar" aria-hidden="true">
            {planSteps.map((s) => (
              <span key={s.id} data-tone={toneOf(s.status)} className={s.id === progress?.plan_step ? 'current' : ''} />
            ))}
          </div>
          <ol className="track" data-testid="plan-step-statuses">
            {planSteps.map((s) => (
              <li key={s.id} className={s.id === progress?.plan_step ? 'current' : ''}>
                <Led value={s.status} />
                <span className="mono track-id">{s.id}</span>
                <span className="track-intent">{intents.get(s.id) ?? ''}</span>
                <Tag value={s.status} />
              </li>
            ))}
          </ol>
        </>
      )}
    </Panel>
  );
}

/** Rolling agent step log (newest first; header clicks re-sort locally). */
export function StepLog({ progress }: { progress: LiveProgressData | null }) {
  const steps = progress?.steps;
  const newestFirst = useMemo(() => [...(steps ?? [])].reverse(), [steps]);
  const [state, setState] = useTableState(null);
  return (
    <Panel title="Agent step log" meta={`${newestFirst.length} steps`}>
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
    </Panel>
  );
}

/** Latest browser observation, framed as a monitor feed. */
export function LiveFeed({ runId, shot, label, awaiting }: { runId: string; shot: string | null; label: string; awaiting: boolean }) {
  if (!shot) {
    return (
      <Panel title="Browser feed" className="feed-panel" meta="no signal">
        <div className="feed feed-empty">
          <p>
            <strong>{awaiting ? 'Execution paused for plan review' : 'Waiting for the first observation'}</strong>
          </p>
          <p className="hint">
            {awaiting
              ? 'Edit the plan below, then approve to start the browser.'
              : 'The latest browser screenshot appears here as soon as the agent observes the page.'}
          </p>
        </div>
      </Panel>
    );
  }
  const src = artifactUrl(runId, `screenshots/${shot}`);
  return (
    <Panel
      title="Browser feed"
      className="feed-panel"
      meta={
        <span className="rec">
          <span className="rec-dot" aria-hidden="true" />
          live · {label}
        </span>
      }
    >
      <figure className="feed" data-testid="live-shot">
        <img src={src} alt="Latest browser observation" />
        <figcaption className="mono">
          <a href={src} target="_blank" rel="noreferrer">
            {shot}
          </a>
        </figcaption>
      </figure>
    </Panel>
  );
}
