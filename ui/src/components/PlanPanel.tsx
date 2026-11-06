import { useMemo, useState } from 'react';
import type { Plan, ReportStep } from '../lib/api.ts';
import { emptyPlan, planChanges, planProblems, renumber } from '../lib/planEdit.ts';
import { Banner, Panel } from './Panel.tsx';
import { Tag } from './StatusBadge.tsx';

interface Props {
  plan: Plan | null;
  reportSteps?: ReportStep[];
  liveSteps?: { id: string; status: string }[]; // per-plan-step statuses while running
  currentStep?: string | null; // status.json plan_step while running
  editable: boolean;
  onApprove: (plan: Plan) => Promise<void>;
  onReject: () => Promise<void>;
}

/** §16.3 plan view: per-step status; editable while awaiting_approval. */
export function PlanPanel({ plan, reportSteps, liveSteps, currentStep, editable, onApprove, onReject }: Props) {
  const [draft, setDraft] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const base = draft ?? plan ?? emptyPlan();
  const outcome = new Map((reportSteps ?? []).map((s) => [s.id, s]));
  const live = new Map((liveSteps ?? []).map((s) => [s.id, s.status]));
  const problems = useMemo(() => planProblems(base), [base]);
  const changes = useMemo(() => (plan ? planChanges(plan, base) : []), [plan, base]);

  const upd = (next: Plan) => setDraft(renumber(next));
  const updStep = (i: number, patch: Partial<Plan['steps'][number]>) =>
    upd({ ...base, steps: base.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const updCrit = (i: number, description: string) =>
    upd({ ...base, criteria: base.criteria.map((c, j) => (j === i ? { ...c, description } : c)) });

  const act = async (which: 'approve' | 'reject') => {
    setBusy(which);
    setError(null);
    try {
      if (which === 'approve') await onApprove(base);
      else await onReject();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  if (!plan && !editable) return null;

  return (
    <Panel
      title={editable ? 'Plan · awaiting approval' : 'Plan'}
      testId="plan-panel"
      className={editable ? 'plan-panel editing' : 'plan-panel'}
      meta={`${base.steps.length} steps · ${base.criteria.length} criteria`}
    >
      {editable ? (
        <div className="field plan-title-field">
          <label htmlFor="plan-title">Plan title</label>
          <input id="plan-title" className="plan-title" value={base.title} onChange={(e) => setDraft({ ...base, title: e.target.value })} />
        </div>
      ) : (
        <p className="plan-name">{base.title}</p>
      )}
      {editable && (
        <p className="hint">
          Execution is paused. Edit the steps and success criteria, then approve to start the browser.
          {changes.length > 0 && <strong className="changes"> {changes.length} unsaved change(s) vs the submitted plan.</strong>}
        </p>
      )}
      {error && <Banner tone="bad">{error}</Banner>}
      <div className="table-wrap">
        <table className="plan">
          <thead>
            <tr>
              <th className="col-id">Step</th>
              <th>Intent</th>
              <th>Expected</th>
              <th className="col-status">Status</th>
              {editable && (
                <th className="col-id">
                  <span className="sr-only">Remove</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {base.steps.map((s, i) => {
              const st = outcome.get(s.id)?.outcome ?? live.get(s.id) ?? (currentStep === s.id ? 'running' : 'open');
              return (
                <tr key={s.id} className={currentStep === s.id ? 'current' : ''}>
                  <td className="mono">{s.id}</td>
                  <td>
                    {editable ? (
                      <textarea
                        rows={3}
                        aria-label={`${s.id} intent`}
                        value={s.intent}
                        onChange={(e) => updStep(i, { intent: e.target.value })}
                      />
                    ) : (
                      s.intent
                    )}
                  </td>
                  <td>
                    {editable ? (
                      <textarea
                        rows={3}
                        aria-label={`${s.id} expected`}
                        value={s.expected}
                        onChange={(e) => updStep(i, { expected: e.target.value })}
                      />
                    ) : (
                      s.expected
                    )}
                    {outcome.get(s.id)?.notes && <div className="cell-sub">{outcome.get(s.id)?.notes}</div>}
                  </td>
                  <td>
                    <Tag value={st} />
                  </td>
                  {editable && (
                    <td>
                      <button
                        type="button"
                        className="btn ghost small"
                        aria-label={`remove ${s.id}`}
                        onClick={() => upd({ ...base, steps: base.steps.filter((_, j) => j !== i) })}
                      >
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editable && (
        <button
          type="button"
          className="btn ghost small add-row"
          onClick={() => upd({ ...base, steps: [...base.steps, { id: `p${base.steps.length + 1}`, intent: '', expected: '' }] })}
        >
          + Add step
        </button>
      )}
      <h3 className="sub-head">Success criteria</h3>
      <div className="table-wrap">
        <table className="plan">
          <tbody>
            {base.criteria.map((c, i) => (
              <tr key={c.id}>
                <td className="mono col-id">{c.id}</td>
                <td>
                  {editable ? (
                    <textarea
                      rows={2}
                      aria-label={`${c.id} description`}
                      value={c.description}
                      onChange={(e) => updCrit(i, e.target.value)}
                    />
                  ) : (
                    c.description
                  )}
                </td>
                {editable && (
                  <td className="col-id">
                    <button
                      type="button"
                      className="btn ghost small"
                      aria-label={`remove ${c.id}`}
                      onClick={() => upd({ ...base, criteria: base.criteria.filter((_, j) => j !== i) })}
                    >
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editable && (
        <>
          <button
            type="button"
            className="btn ghost small add-row"
            onClick={() => upd({ ...base, criteria: [...base.criteria, { id: `c${base.criteria.length + 1}`, description: '' }] })}
          >
            + Add criterion
          </button>
          {problems.length > 0 && <p className="hint warn">{problems.join('; ')}</p>}
          <div className="approval-bar">
            <button
              type="button"
              className="btn primary"
              disabled={busy !== null || problems.length > 0}
              onClick={() => void act('approve')}
            >
              {busy === 'approve' ? 'Approving…' : 'Approve plan'}
            </button>
            <button type="button" className="btn danger" disabled={busy !== null} onClick={() => void act('reject')}>
              {busy === 'reject' ? 'Rejecting…' : 'Reject plan'}
            </button>
          </div>
        </>
      )}
    </Panel>
  );
}
