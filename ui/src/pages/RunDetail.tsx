import { useCallback, useEffect, useRef, useState } from 'react';
import { Gallery } from '../components/Gallery.tsx';
import { LiveProgress } from '../components/LiveProgress.tsx';
import { PlanPanel } from '../components/PlanPanel.tsx';
import { ReportPanel } from '../components/ReportPanel.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { Timeline } from '../components/Timeline.tsx';
import { VideoPanel } from '../components/VideoPanel.tsx';
import {
  apiGet,
  apiPost,
  artifactUrl,
  type ChaptersFile,
  type LiveProgress as LiveProgressData,
  type Plan,
  type RunDetail,
  type RunJson,
  type StatusInfo,
  type TimelineEvent,
} from '../lib/api.ts';
import { nav } from '../lib/router.ts';
import { badgeOf, fmtDateTime, fmtDuration } from '../lib/status.ts';

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

export function RunDetailPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<StatusInfo | null>(null);
  const [liveRun, setLiveRun] = useState<RunJson | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [progress, setProgress] = useState<LiveProgressData | null>(null);
  const [shots, setShots] = useState<string[]>([]);
  const [chapters, setChapters] = useState<ChaptersFile | null>(null);
  const [sseState, setSseState] = useState<'open' | 'closed'>('closed');
  const eventsSeen = useRef(new Set<number>());

  const load = useCallback(async () => {
    try {
      const d = await apiGet<RunDetail>(`/api/runs/${id}`);
      setDetail(d);
      if (d.progress) setProgress(d.progress);
      setError(null);
      return d;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [id]);

  const loadShots = useCallback(async () => {
    try {
      const { screenshots } = await apiGet<{ screenshots: string[] }>(`/api/runs/${id}/screenshots`);
      setShots(screenshots);
    } catch {
      /* endpoint or dir absent yet */
    }
  }, [id]);

  const loadTerminalArtifacts = useCallback(async () => {
    try {
      setChapters(await apiGet<ChaptersFile>(artifactUrl(id, 'chapters.json')));
    } catch {
      /* no postprocess output */
    }
    try {
      const text = await (await fetch(artifactUrl(id, 'events.jsonl'))).text();
      const evs = text
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as TimelineEvent);
      for (const e of evs) eventsSeen.current.add(e.seq);
      setEvents(evs);
    } catch {
      /* no events file */
    }
    void loadShots();
    void load();
  }, [id, load, loadShots]);

  const run = liveRun ?? detail?.run ?? null;
  const phase = liveStatus?.phase ?? detail?.status?.phase ?? null;
  const terminal = run !== null || phase === 'done';
  const statusText = run?.status ?? phase ?? detail?.runner_state ?? 'submitted';

  // Initial load + detail refresh every 4 s while non-terminal.
  useEffect(() => {
    let cancelled = false;
    void load().then((d) => {
      if (d?.run) void loadTerminalArtifacts();
      else void loadShots();
    });
    const iv = window.setInterval(() => {
      if (cancelled) return;
      void load().then((d) => {
        if (d?.run) void loadTerminalArtifacts();
      });
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [load, loadShots, loadTerminalArtifacts]);

  // Live screenshots every 1.5 s while the run is non-terminal.
  useEffect(() => {
    if (terminal) return;
    const iv = window.setInterval(() => void loadShots(), 1500);
    return () => window.clearInterval(iv);
  }, [terminal, loadShots]);

  // SSE: timeline events + status.json changes; the server closes with a 'done'
  // event once run.json exists. EventSource reconnects on stream failure using
  // the server's `retry:` interval; we close permanently at terminal state.
  useEffect(() => {
    if (terminal) return;
    const es = new EventSource(`/api/runs/${id}/events`);
    setSseState('open');
    es.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data as string) as TimelineEvent;
        if (!eventsSeen.current.has(e.seq)) {
          eventsSeen.current.add(e.seq);
          setEvents((prev) => [...prev, e]);
        }
      } catch {
        /* partial line */
      }
    };
    es.addEventListener('status', (m) => {
      try {
        setLiveStatus(JSON.parse((m as MessageEvent).data as string) as StatusInfo);
      } catch {
        /* partial write */
      }
    });
    es.addEventListener('progress', (m) => {
      try {
        setProgress(JSON.parse((m as MessageEvent).data as string) as LiveProgressData);
      } catch {
        /* partial write */
      }
    });
    es.addEventListener('done', (m) => {
      try {
        setLiveRun(JSON.parse((m as MessageEvent).data as string) as RunJson);
      } catch {
        /* partial write */
      }
      es.close();
      setSseState('closed');
      void loadTerminalArtifacts();
    });
    es.onerror = () => {
      // EventSource keeps reconnecting at the server-sent retry interval.
      if (es.readyState === EventSource.CLOSED) setSseState('closed');
    };
    return () => {
      es.close();
      setSseState('closed');
    };
  }, [id, terminal, loadTerminalArtifacts]);

  const post = useCallback(async <T,>(sub: string, body: unknown): Promise<T> => apiPost<T>(`/api/runs/${id}/${sub}`, body), [id]);

  const onApprove = async (plan: Plan) => {
    await post('approve', { plan });
    await load();
  };
  const onReject = async () => {
    await post('reject', {});
    await load();
  };
  const act = async (action: 'cancel' | 'rerun') => {
    setActionBusy(true);
    setActionError(null);
    try {
      if (action === 'rerun') {
        const r = await post<{ run_id: string }>('rerun', {});
        nav(`/run/${r.run_id}`);
      } else {
        await post('cancel', {});
        await load();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const latestShot = shots.at(-1) ?? progress?.latest_screenshot ?? null;
  const currentPlanStep = progress?.plan_step ?? liveStatus?.plan_step ?? detail?.status?.plan_step ?? null;
  const awaiting = phase === 'awaiting_approval';
  const report = detail?.report ?? null;
  const egress = run?.egress ?? report?.egress ?? null;
  const badge = badgeOf(statusText);

  return (
    <section className="run-detail">
      <p className="eyebrow">
        <a href="#/">Runs</a> / Execution detail
      </p>
      <div className="row spread">
        <h2>
          {detail?.request && typeof (detail.request as { form?: { title?: string } }).form?.title === 'string'
            ? ((detail.request as { form?: { title?: string } }).form?.title as string)
            : (report?.title ?? id)}
        </h2>
        <div className="row">
          <button type="button" className="btn danger" disabled={terminal || actionBusy} onClick={() => void act('cancel')}>
            Cancel
          </button>
          <button type="button" className="btn" disabled={actionBusy} onClick={() => void act('rerun')}>
            Rerun
          </button>
          <a className="btn" href="#/">
            Runs
          </a>
        </div>
      </div>
      {(error || actionError) && (
        <div className="banner error" role="alert">
          {actionError ?? error}
        </div>
      )}
      <div className="meta mono">
        <StatusBadge status={statusText} /> <span data-testid="phase">{badge.text}</span> · run <span>{id}</span>
        {currentPlanStep && <span> · step {currentPlanStep}</span>}
        {detail?.spec && typeof (detail.spec as { model?: string }).model === 'string' ? '' : ''}
        <span> · {terminal ? 'Evidence collected' : sseState === 'open' ? 'Live updates connected' : 'Connecting to live updates'}</span>
      </div>
      <div className="meta mono muted">
        {report?.model ?? (detail?.request as { model?: string } | null)?.model ?? ''} · started {fmtDateTime(run?.started_at ?? null)} ·
        duration {fmtDuration(run?.started_at ?? null, run?.ended_at ?? null)}
        {run?.tokens && ` · tokens ${run.tokens.input ?? 0}/${run.tokens.output ?? 0}`}
        {run?.exit_code !== undefined && ` · exit ${run.exit_code}`}
      </div>
      {run?.summary && <div className="banner">{run.summary}</div>}

      <nav className="section-nav" aria-label="Run sections">
        {['overview', 'plan', 'recording', 'screenshots', 'activity', 'downloads'].map((section) => (
          <a
            key={section}
            href={`#section-${section}`}
            onClick={(e) => {
              e.preventDefault();
              document.getElementById(`section-${section}`)?.scrollIntoView({ behavior: 'instant', block: 'start' });
            }}
          >
            {section}
          </a>
        ))}
      </nav>
      {!terminal && <LiveProgress progress={progress} fallbackPhase={phase} />}
      <div className="cols">
        <div>
          <div id="section-overview">
            <ReportPanel runId={id} report={report} />
          </div>
          {!terminal && !latestShot && (
            <div className="panel empty-state">
              <h3>{awaiting ? 'Review the execution plan' : 'Preparing browser evidence'}</h3>
              <p className="muted">
                {awaiting
                  ? 'Edit the steps and criteria below, then approve to begin.'
                  : 'The latest browser observation will appear here as execution begins.'}
              </p>
            </div>
          )}
          {!terminal && latestShot && (
            <section className="panel" data-testid="live-shot">
              <div className="row spread">
                <h3>Live browser</h3>
                <span className="chip chip-running">{currentPlanStep ?? badge.text}</span>
              </div>
              <img src={artifactUrl(id, `screenshots/${latestShot}`)} alt="latest observation" className="live-img" />
            </section>
          )}
          <div id="section-plan">
            <PlanPanel
              plan={detail?.plan ?? null}
              reportSteps={report?.plan?.steps}
              liveSteps={progress?.plan_steps}
              currentStep={currentPlanStep}
              editable={awaiting}
              onApprove={onApprove}
              onReject={onReject}
            />
          </div>
          <div id="section-recording">
            <VideoPanel runId={id} data={chapters} />
          </div>
          <div id="section-screenshots">
            <Gallery runId={id} report={report} names={shots} />
          </div>
        </div>
        <div>
          <div id="section-activity">
            <Timeline events={events} maxRows={terminal ? undefined : 25} />
          </div>
          {egress && (
            <section className="panel">
              <h3>Egress</h3>
              <p className="mono small">
                allowed {egress.allowed}
                {egress.denied.length > 0 && ` · denied ${egress.denied.map((d) => `${d.host}×${d.count}`).join(', ')}`}
              </p>
            </section>
          )}
          {detail && (
            <section className="panel" id="section-downloads">
              <h3>Artifacts</h3>
              <ul className="links">
                {ARTIFACT_FILES.map((f) => (
                  <li key={f}>
                    <a href={artifactUrl(id, f)} target={f.endsWith('.html') ? '_blank' : undefined} rel="noreferrer">
                      {f}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </section>
  );
}
