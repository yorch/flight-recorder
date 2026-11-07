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
  { file: 'run.json', what: 'Run result: verdict, steps, tokens, egress' },
  { file: 'plan.json', what: 'Approved plan' },
  { file: 'evaluation.json', what: 'Evaluator verdicts per criterion' },
  { file: 'network.jsonl', what: 'Browser requests and responses (headers only)' },
  { file: 'agent/transcript.jsonl', what: 'Model transcript' },
  { file: 'logs/proxy-access.log', what: 'Egress proxy access log' },
];

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

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

/** Lists only files that exist (from the detail API), known ones first with descriptions. */
export function ArtifactsPanel({ runId, files, terminal }: { runId: string; files: { file: string; bytes: number }[]; terminal: boolean }) {
  const sizes = new Map(files.map((f) => [f.file, f.bytes]));
  const known = ARTIFACT_FILES.filter((f) => sizes.has(f.file));
  const knownNames = new Set(ARTIFACT_FILES.map((f) => f.file));
  const rows = [...known, ...files.filter((f) => !knownNames.has(f.file)).map((f) => ({ file: f.file, what: '' }))];
  const pending = ARTIFACT_FILES.length - known.length;
  return (
    <Panel title="Artifacts" testId="artifacts" meta={`artifacts/${runId}/ · ${rows.length} files`}>
      {rows.length === 0 ? (
        <p className="hint">No artifacts yet. Files appear here as the run writes them.</p>
      ) : (
        <table className="kv-table manifest" aria-label="Artifact files">
          <tbody>
            {rows.map((f) => (
              <tr key={f.file}>
                <td className="mono">
                  <a href={artifactUrl(runId, f.file)} target={f.file.endsWith('.html') ? '_blank' : undefined} rel="noreferrer">
                    {f.file}
                  </a>
                </td>
                <td>{f.what}</td>
                <td className="mono num">{fmtBytes(sizes.get(f.file) ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!terminal && pending > 0 && <p className="hint">Run in progress: video, chapters and report are written after the run finishes.</p>}
    </Panel>
  );
}
