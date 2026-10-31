import { useMemo, useState } from 'react';
import type { Plan, ReportStep } from '../lib/api.ts';
import { emptyPlan, planChanges, planProblems, renumber } from '../lib/planEdit.ts';

interface Props {
  plan: Plan | null;
  reportSteps?: ReportStep[];
  currentStep?: string | null; // status.json plan_step while running
  editable: boolean;
  onApprove: (plan: Plan) => Promise<void>;
  onReject: () => Promise<void>;
}

/** §16.3 plan view: per-step status; editable while awaiting_approval. */
export function PlanPanel({ plan, reportSteps, currentStep, editable, onApprove, onReject }: Props) {
  const [draft, setDraft] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const base = draft ?? plan ?? emptyPlan();
  const outcome = new Map((reportSteps ?? []).map((s) => [s.id, s]));
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
    <section className="panel" data-testid="plan-panel">
      <h3>
        Plan{editable ? ' — awaiting approval' : ''}
        {editable ? (
          <input
            className="plan-title"
            aria-label="plan title"
            value={base.title}
            onChange={(e) => setDraft({ ...base, title: e.target.value })}
          />
        ) : (
          <span className="muted"> {base.title}</span>
        )}
      </h3>
      {editable && <p className="approval-hint">Execution is paused. Review the steps and success criteria before approving.</p>}
      {error && <div className="banner error">{error}</div>}
      {editable && changes.length > 0 && <div className="muted small">{changes.length} unsaved change(s) vs submitted plan</div>}
      <div className="table-wrap">
        <table className="plan">
          <thead>
            <tr>
              <th>Step</th>
              <th>Intent</th>
              <th>Expected</th>
              <th>Status</th>
              {editable && <th />}
            </tr>
          </thead>
          <tbody>
            {base.steps.map((s, i) => {
              const st = outcome.get(s.id)?.outcome ?? (currentStep === s.id ? 'running' : 'open');
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
                    {outcome.get(s.id)?.notes && <div className="muted small">{outcome.get(s.id)?.notes}</div>}
                  </td>
                  <td>
                    <span className={`chip chip-${st.toLowerCase()}`}>{st}</span>
                  </td>
                  {editable && (
                    <td>
                      <button
                        type="button"
                        className="btn small"
                        aria-label={`remove ${s.id}`}
                        onClick={() => upd({ ...base, steps: base.steps.filter((_, j) => j !== i) })}
                      >
                        ×
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
          className="btn small"
          onClick={() => upd({ ...base, steps: [...base.steps, { id: `p${base.steps.length + 1}`, intent: '', expected: '' }] })}
        >
          + add step
        </button>
      )}
      <h4>Criteria</h4>
      <div className="table-wrap">
        <table className="plan">
          <tbody>
            {base.criteria.map((c, i) => (
              <tr key={c.id}>
                <td className="mono">{c.id}</td>
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
                  <td>
                    <button
                      type="button"
                      className="btn small"
                      aria-label={`remove ${c.id}`}
                      onClick={() => upd({ ...base, criteria: base.criteria.filter((_, j) => j !== i) })}
                    >
                      ×
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
            className="btn small"
            onClick={() => upd({ ...base, criteria: [...base.criteria, { id: `c${base.criteria.length + 1}`, description: '' }] })}
          >
            + add criterion
          </button>
          {problems.length > 0 && <div className="warn small">{problems.join('; ')}</div>}
          <div className="row">
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
    </section>
  );
}
