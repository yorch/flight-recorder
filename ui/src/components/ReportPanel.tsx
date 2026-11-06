import { useMemo, useState } from 'react';
import type { Report, ReportCriterion, RunJson } from '../lib/api.ts';
import { artifactUrl, screenshotUrl } from '../lib/api.ts';
import { baseName, shotsFromRefs } from '../lib/gallery.ts';
import { fmtDuration, toneOf } from '../lib/status.ts';
import { useTableState } from '../lib/useTableState.ts';
import { type Column, DataTable } from './DataTable.tsx';
import { Lightbox } from './Lightbox.tsx';
import { Panel } from './Panel.tsx';
import { Tag } from './StatusBadge.tsx';

export const critStatus = (c: ReportCriterion): string => (c.verified ? 'VERIFIED' : c.evaluator_status);

const SEVERITIES = ['high', 'medium', 'low'] as const;

/** Verdict counts for the hero readout. */
export function verdictStats(report: Report) {
  const crit = report.plan?.criteria ?? [];
  const met = crit.filter((c) => toneOf(critStatus(c)) === 'ok').length;
  const sev = Object.fromEntries(SEVERITIES.map((s) => [s, report.issues.filter((i) => i.severity === s).length])) as Record<
    (typeof SEVERITIES)[number],
    number
  >;
  const assertions = report.assertions.length;
  const assertionsPassed = report.assertions.filter((a) => a.passed).length;
  return { met, criteria: crit.length, sev, assertions, assertionsPassed };
}

/**
 * Verdict hero (§15.5): status, summary, criteria/issue/assertion counts and
 * conclusions. Every string is rendered through JSX, so it is escaped.
 */
export function VerdictPanel({ runId, report, run }: { runId: string; report: Report | null; run: RunJson | null }) {
  if (!report) {
    if (!run) return null;
    // Terminal run without a §15.6 report (cancelled early, legacy spec runs).
    return (
      <section className="verdict" data-tone={toneOf(run.status)}>
        <div className="verdict-status">
          <span className="verdict-word">{run.status}</span>
          {run.exit_code !== undefined && <span className="mono">exit {run.exit_code}</span>}
        </div>
        <div className="verdict-body">
          <p className="verdict-summary">{run.summary ?? 'The run ended without a report.'}</p>
        </div>
      </section>
    );
  }
  const s = verdictStats(report);
  return (
    <section className="verdict" data-tone={toneOf(report.status)} data-testid="report-panel">
      <div className="verdict-status" data-testid="verdict">
        <span className="verdict-word">{report.status}</span>
        <p className="verdict-summary">{report.summary}</p>
      </div>
      <div className="verdict-body">
        <dl className="verdict-stats">
          <div data-tone={s.criteria && s.met === s.criteria ? 'ok' : s.criteria ? 'bad' : 'idle'}>
            <dt>Criteria met</dt>
            <dd>
              {s.met}/{s.criteria}
            </dd>
          </div>
          <div data-tone={s.assertions && s.assertionsPassed < s.assertions ? 'bad' : 'idle'}>
            <dt>Assertions</dt>
            <dd>
              {s.assertionsPassed}/{s.assertions}
            </dd>
          </div>
          <div data-tone={s.sev.high ? 'bad' : s.sev.medium ? 'warn' : 'idle'}>
            <dt>Issues h/m/l</dt>
            <dd>
              {s.sev.high}/{s.sev.medium}/{s.sev.low}
            </dd>
          </div>
          <div>
            <dt>Wall time</dt>
            <dd>{fmtDuration(report.timing.started_at, report.timing.ended_at)}</dd>
          </div>
        </dl>
        {report.conclusions && (
          <div className="conclusions" data-testid="conclusions">
            <h3>Conclusions</h3>
            <p>{report.conclusions}</p>
          </div>
        )}
        <p className="verdict-links mono">
          <a href={artifactUrl(runId, 'report.html')} target="_blank" rel="noreferrer">
            report.html
          </a>
          <a href={artifactUrl(runId, 'report.md')} target="_blank" rel="noreferrer">
            report.md
          </a>
          <a href={artifactUrl(runId, 'report.json')} target="_blank" rel="noreferrer">
            report.json
          </a>
        </p>
      </div>
    </section>
  );
}

/** Criteria table with evidence + issues list; evidence screenshots open in one navigable lightbox. */
export function CriteriaPanel({ runId, report }: { runId: string; report: Report | null }) {
  const [state, setState] = useTableState(null);
  const [index, setIndex] = useState<number | null>(null);

  const shots = useMemo(
    () =>
      report
        ? shotsFromRefs(runId, [
            ...(report.plan?.criteria ?? []).flatMap((c) => c.screenshots.map((ref) => ({ ref, group: `${c.id} — ${c.description}` }))),
            ...report.issues.flatMap((i) => (i.screenshot ? [{ ref: i.screenshot, group: `issue — ${i.title}` }] : [])),
          ])
        : [],
    [runId, report],
  );
  const openShot = (ref: string, el: HTMLElement) => {
    el.focus();
    const at = shots.findIndex((s) => s.src === screenshotUrl(runId, ref));
    setIndex(at < 0 ? null : at);
  };
  const shotLink = (ref: string) => (
    <button key={ref} type="button" className="link-btn mono" onClick={(e) => openShot(ref, e.currentTarget)}>
      {baseName(ref)}
    </button>
  );

  const columns: Column<ReportCriterion>[] = [
    { key: 'id', label: 'Id', value: (c) => c.id, className: 'mono nowrap' },
    { key: 'description', label: 'Criterion', value: (c) => c.description },
    { key: 'status', label: 'Status', value: critStatus, filter: 'select', render: (c) => <Tag value={critStatus(c)} /> },
    {
      key: 'evidence',
      label: 'Evidence',
      value: (c) => c.evidence,
      sortable: false,
      render: (c) => (
        <>
          {c.evidence}
          {c.screenshots.length > 0 && <div className="evidence-shots">{c.screenshots.map(shotLink)}</div>}
          {c.assertions.length > 0 && (
            <ul className="assertions">
              {c.assertions.map((a) => (
                <li key={`${a.step_id}-${a.label}`} data-tone={a.passed ? 'ok' : 'bad'}>
                  <span className="mono">{a.step_id}</span> {a.label} <strong className="mono">{a.passed ? 'PASS' : 'FAIL'}</strong>
                </li>
              ))}
            </ul>
          )}
        </>
      ),
    },
  ];

  if (!report || (!report.plan && report.issues.length === 0)) return null;
  return (
    <Panel title="Criteria and issues" meta={`${report.plan?.criteria.length ?? 0} criteria · ${report.issues.length} issues`}>
      {report.plan && (
        <DataTable
          label="Success criteria"
          noun="criteria"
          columns={columns}
          rows={report.plan.criteria}
          rowKey={(c) => c.id}
          state={state}
          onState={setState}
          testId="criteria-table"
          rowClassName={(c) => `tone-row-${toneOf(critStatus(c))}`}
        />
      )}
      {report.issues.length > 0 && (
        <ul className="issues" data-testid="issues">
          {report.issues.map((i) => (
            <li
              key={`${i.severity}-${i.title}-${i.plan_step ?? ''}`}
              className={`issue issue-${i.severity}`}
              data-tone={toneOf(i.severity)}
            >
              <div className="issue-head">
                <Tag value={i.severity} />
                <strong>{i.title}</strong>
                {i.plan_step && <span className="mono cell-sub">{i.plan_step}</span>}
              </div>
              <p>{i.description}</p>
              {i.screenshot && <div className="evidence-shots">{shotLink(i.screenshot)}</div>}
            </li>
          ))}
        </ul>
      )}
      <Lightbox shots={shots} index={index} onIndex={setIndex} label="Evidence screenshot" />
    </Panel>
  );
}
