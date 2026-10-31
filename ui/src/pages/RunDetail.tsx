import { useState } from 'react';
import { ArtifactsPanel, EgressPanel } from '../components/ArtifactsPanel.tsx';
import { Gallery } from '../components/Gallery.tsx';
import { LiveProgress } from '../components/LiveProgress.tsx';
import { NetworkPanel } from '../components/NetworkPanel.tsx';
import { PlanPanel } from '../components/PlanPanel.tsx';
import { ReportPanel } from '../components/ReportPanel.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { Timeline } from '../components/Timeline.tsx';
import { VideoPanel } from '../components/VideoPanel.tsx';
import { apiPost, artifactUrl, type Plan, type RunDetail } from '../lib/api.ts';
import { nav } from '../lib/router.ts';
import { badgeOf, fmtDateTime, fmtDuration } from '../lib/status.ts';
import { useRunDetail } from '../lib/useRunDetail.ts';

const SECTIONS = ['overview', 'plan', 'recording', 'screenshots', 'network', 'activity', 'downloads'] as const;

const titleOf = (detail: RunDetail | null, id: string): string => {
  const t = (detail?.request as { form?: { title?: unknown } } | null)?.form?.title;
  return typeof t === 'string' && t ? t : (detail?.report?.title ?? id);
};

function SectionNav() {
  return (
    <nav className="section-nav" aria-label="Run sections">
      {SECTIONS.map((section) => (
        <a
          key={section}
          href={`#section-${section}`}
          onClick={(e) => {
            // Keep the hash for routing: scroll instead of navigating.
            e.preventDefault();
            document.getElementById(`section-${section}`)?.scrollIntoView({ behavior: 'instant', block: 'start' });
          }}
        >
          {section}
        </a>
      ))}
    </nav>
  );
}

export function RunDetailPage({ id }: { id: string }) {
  const data = useRunDetail(id);
  const { detail, run, phase, terminal, progress, shots, liveStatus } = data;
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const post = <T,>(sub: string, body: unknown): Promise<T> => apiPost<T>(`/api/runs/${id}/${sub}`, body);
  const onApprove = async (plan: Plan) => {
    await post('approve', { plan });
    await data.reload();
  };
  const onReject = async () => {
    await post('reject', {});
    await data.reload();
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
        await data.reload();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const statusText = run?.status ?? phase ?? detail?.runner_state ?? 'submitted';
  const badge = badgeOf(statusText);
  const latestShot = shots.at(-1) ?? progress?.latest_screenshot ?? null;
  const currentPlanStep = progress?.plan_step ?? liveStatus?.plan_step ?? detail?.status?.plan_step ?? null;
  const awaiting = phase === 'awaiting_approval';
  const report = detail?.report ?? null;
  const egress = run?.egress ?? report?.egress ?? null;
  const error = actionError ?? data.error;

  return (
    <section className="run-detail">
      <p className="eyebrow">
        <a href="#/">Runs</a> / Execution detail
      </p>
      <div className="row spread">
        <h2>{titleOf(detail, id)}</h2>
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
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      <div className="meta mono">
        <StatusBadge status={statusText} /> <span data-testid="phase">{badge.text}</span> · run <span>{id}</span>
        {currentPlanStep && <span> · step {currentPlanStep}</span>}
        <span>
          {' '}
          · {terminal ? 'Evidence collected' : data.sseState === 'open' ? 'Live updates connected' : 'Connecting to live updates'}
        </span>
      </div>
      <div className="meta mono muted">
        {report?.model ?? (detail?.request as { model?: string } | null)?.model ?? ''} · started {fmtDateTime(run?.started_at ?? null)} ·
        duration {fmtDuration(run?.started_at ?? null, run?.ended_at ?? null)}
        {run?.tokens && ` · tokens ${run.tokens.input ?? 0}/${run.tokens.output ?? 0}`}
        {run?.exit_code !== undefined && ` · exit ${run.exit_code}`}
      </div>
      {run?.summary && <div className="banner">{run.summary}</div>}

      <SectionNav />
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
            <VideoPanel runId={id} data={data.chapters} />
          </div>
          <div id="section-screenshots">
            <Gallery runId={id} report={report} names={shots} />
          </div>
          <div id="section-network">{detail && <NetworkPanel runId={id} live={!terminal} />}</div>
        </div>
        <div>
          <div id="section-activity">
            <Timeline events={data.events} maxRows={terminal ? undefined : 25} />
          </div>
          <EgressPanel egress={egress} />
          {detail && <ArtifactsPanel runId={id} />}
        </div>
      </div>
    </section>
  );
}
