import type { RunJson } from '../lib/api.ts';
import { artifactUrl } from '../lib/api.ts';

const ARTIFACT_FILES = [
  'final.mp4',
  'raw.mkv',
  'chapters.vtt',
  'chapters.json',
  'timemap.json',
  'events.jsonl',
  'report.html',
  'report.md',
  'report.json',
];

export function EgressPanel({ egress }: { egress: RunJson['egress'] }) {
  if (!egress) return null;
  return (
    <section className="panel">
      <h3>Egress</h3>
      <p className="mono small">
        allowed {egress.allowed}
        {egress.denied.length > 0 && ` · denied ${egress.denied.map((d) => `${d.host}×${d.count}`).join(', ')}`}
      </p>
    </section>
  );
}

export function ArtifactsPanel({ runId }: { runId: string }) {
  return (
    <section className="panel" id="section-downloads">
      <h3>Artifacts</h3>
      <ul className="links">
        {ARTIFACT_FILES.map((f) => (
          <li key={f}>
            <a href={artifactUrl(runId, f)} target={f.endsWith('.html') ? '_blank' : undefined} rel="noreferrer">
              {f}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
