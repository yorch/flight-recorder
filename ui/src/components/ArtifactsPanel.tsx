import type { RunJson } from '../lib/api.ts';
import { artifactUrl } from '../lib/api.ts';
import { Panel } from './Panel.tsx';

export const ARTIFACT_FILES: { file: string; what: string }[] = [
  { file: 'final.mp4', what: 'Condensed video: idle compressed, zoom on actions' },
  { file: 'raw.mkv', what: 'Uncut screen recording' },
  { file: 'chapters.vtt', what: 'Chapter track (WebVTT)' },
  { file: 'chapters.json', what: 'Chapters with pass/fail status' },
  { file: 'timemap.json', what: 'Raw-to-final time mapping' },
  { file: 'events.jsonl', what: 'Event timeline, one JSON object per line' },
  { file: 'report.html', what: 'Standalone report' },
  { file: 'report.md', what: 'Report as Markdown' },
  { file: 'report.json', what: 'Machine-readable report' },
];

export function EgressPanel({ egress }: { egress: RunJson['egress'] }) {
  if (!egress) return null;
  const denied = egress.denied.reduce((n, d) => n + d.count, 0);
  return (
    <Panel title="Egress" testId="egress" meta={`${egress.allowed} allowed · ${denied} denied`}>
      <div className="gauges gauges-2">
        <div className="gauge" data-tone="ok">
          <span>Allowed requests</span>
          <strong>{egress.allowed}</strong>
        </div>
        <div className="gauge" data-tone={denied ? 'bad' : 'idle'}>
          <span>Denied requests</span>
          <strong>{denied}</strong>
        </div>
      </div>
      {egress.denied.length > 0 ? (
        <table className="kv-table" aria-label="Denied hosts">
          <thead>
            <tr>
              <th>Denied host</th>
              <th className="num">Count</th>
            </tr>
          </thead>
          <tbody>
            {egress.denied.map((d) => (
              <tr key={d.host} className="tone-row-bad">
                <td className="mono">{d.host}</td>
                <td className="mono num">{d.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="hint">No request left the allowlist.</p>
      )}
    </Panel>
  );
}

export function ArtifactsPanel({ runId }: { runId: string }) {
  return (
    <Panel title="Artifacts" testId="artifacts" meta={`artifacts/${runId}/`}>
      <table className="kv-table manifest" aria-label="Artifact files">
        <tbody>
          {ARTIFACT_FILES.map((f) => (
            <tr key={f.file}>
              <td className="mono">
                <a href={artifactUrl(runId, f.file)} target={f.file.endsWith('.html') ? '_blank' : undefined} rel="noreferrer">
                  {f.file}
                </a>
              </td>
              <td>{f.what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
