import type { Report } from '../lib/api.ts';
import { artifactUrl, screenshotUrl } from '../lib/api.ts';
import { StatusBadge } from './StatusBadge.tsx';

/** §15.6 report.json rendered through React — every string is escaped by JSX. */
export function ReportPanel({ runId, report }: { runId: string; report: Report | null }) {
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
          <table>
            <thead>
              <tr>
                <th>Id</th>
                <th>Description</th>
                <th>Status</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {report.plan.criteria.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.id}</td>
                  <td>{c.description}</td>
                  <td>
                    <span className={`chip chip-${(c.verified ? 'verified' : c.evaluator_status).toLowerCase()}`}>
                      {c.verified ? 'VERIFIED' : c.evaluator_status}
                    </span>
                  </td>
                  <td>
                    {c.evidence}
                    {c.screenshots.length > 0 && (
                      <div className="small">
                        {c.screenshots.map((s) => (
                          <a key={s} href={screenshotUrl(runId, s)} target="_blank" rel="noreferrer">
                            {s}
                          </a>
                        ))}
                      </div>
                    )}
                    {c.assertions.length > 0 && (
                      <div className="muted small">
                        {c.assertions.map((a) => `${a.step_id} ${a.label}: ${a.passed ? 'PASS' : 'FAIL'}`).join('; ')}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
              {i.screenshot && (
                <a className="small" href={screenshotUrl(runId, i.screenshot)} target="_blank" rel="noreferrer">
                  {i.screenshot}
                </a>
              )}
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
    </section>
  );
}
