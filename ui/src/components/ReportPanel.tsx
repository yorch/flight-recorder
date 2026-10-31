import { useMemo, useState } from 'react';
import type { Report, ReportCriterion } from '../lib/api.ts';
import { artifactUrl, screenshotUrl } from '../lib/api.ts';
import { baseName, shotsFromRefs } from '../lib/gallery.ts';
import { useTableState } from '../lib/useTableState.ts';
import { type Column, DataTable } from './DataTable.tsx';
import { Lightbox } from './Lightbox.tsx';
import { StatusBadge } from './StatusBadge.tsx';

const critStatus = (c: ReportCriterion): string => (c.verified ? 'VERIFIED' : c.evaluator_status);

/** §15.6 report.json rendered through React — every string is escaped by JSX. */
export function ReportPanel({ runId, report }: { runId: string; report: Report | null }) {
  const [state, setState] = useTableState(null);
  const [index, setIndex] = useState<number | null>(null);

  // Every evidence screenshot (criteria first, then issues) as one navigable sequence.
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
    <button key={ref} type="button" className="link-btn" onClick={(e) => openShot(ref, e.currentTarget)}>
      {baseName(ref)}
    </button>
  );

  const columns: Column<ReportCriterion>[] = [
    { key: 'id', label: 'Id', value: (c) => c.id, className: 'mono' },
    { key: 'description', label: 'Description', value: (c) => c.description },
    {
      key: 'status',
      label: 'Status',
      value: critStatus,
      filter: 'select',
      render: (c) => <span className={`chip chip-${critStatus(c).toLowerCase()}`}>{critStatus(c)}</span>,
    },
    {
      key: 'evidence',
      label: 'Evidence',
      value: (c) => c.evidence,
      sortable: false,
      render: (c) => (
        <>
          {c.evidence}
          {c.screenshots.length > 0 && <div className="small evidence-shots">{c.screenshots.map(shotLink)}</div>}
          {c.assertions.length > 0 && (
            <div className="muted small">
              {c.assertions.map((a) => `${a.step_id} ${a.label}: ${a.passed ? 'PASS' : 'FAIL'}`).join('; ')}
            </div>
          )}
        </>
      ),
    },
  ];

  if (!report) return null;
  return (
    <section className="panel" data-testid="report-panel">
      <div className={`verdict verdict-${report.status.toLowerCase()}`} data-testid="verdict">
        <StatusBadge status={report.status} /> <strong>{report.status}</strong> — {report.summary}
      </div>
      {report.conclusions && (
        <div className="conclusions" data-testid="conclusions">
          <h3>Conclusions</h3>
          <p>{report.conclusions}</p>
        </div>
      )}
      {report.plan && (
        <>
          <h3>Criteria</h3>
          <DataTable
            label="Success criteria"
            noun="criteria"
            columns={columns}
            rows={report.plan.criteria}
            rowKey={(c) => c.id}
            state={state}
            onState={setState}
            testId="criteria-table"
          />
        </>
      )}
      {report.issues.length > 0 && (
        <>
          <h3>Issues</h3>
          {report.issues.map((i) => (
            <div key={`${i.severity}-${i.title}-${i.plan_step ?? ''}`} className={`issue issue-${i.severity}`}>
              <strong>{i.severity}</strong> {i.title}
              {i.plan_step && <em className="mono"> {i.plan_step}</em>}
              <div className="muted small">{i.description}</div>
              {i.screenshot && <div className="small">{shotLink(i.screenshot)}</div>}
            </div>
          ))}
        </>
      )}
      <p className="muted small">
        <a href={artifactUrl(runId, 'report.html')} target="_blank" rel="noreferrer">
          report.html
        </a>{' '}
        ·{' '}
        <a href={artifactUrl(runId, 'report.md')} target="_blank" rel="noreferrer">
          report.md
        </a>{' '}
        ·{' '}
        <a href={artifactUrl(runId, 'report.json')} target="_blank" rel="noreferrer">
          report.json
        </a>
      </p>
      <Lightbox shots={shots} index={index} onIndex={setIndex} label="Evidence screenshot" />
    </section>
  );
}
