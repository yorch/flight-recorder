import { type ReactNode, useCallback, useState } from 'react';
import { ArtifactsPanel, EgressPanel } from '../components/ArtifactsPanel.tsx';
import { Gallery } from '../components/Gallery.tsx';
import { LiveFeed, LiveProgress, StepLog } from '../components/LiveProgress.tsx';
import { NetworkPanel } from '../components/NetworkPanel.tsx';
import { Banner } from '../components/Panel.tsx';
import { PlanPanel } from '../components/PlanPanel.tsx';
import { CriteriaPanel, VerdictPanel } from '../components/ReportPanel.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { Tabs } from '../components/Tabs.tsx';
import { Timeline, timelineRows } from '../components/Timeline.tsx';
import { VideoPanel } from '../components/VideoPanel.tsx';
import { apiPost, type Plan, type RunDetail } from '../lib/api.ts';
import { groupScreenshots } from '../lib/gallery.ts';
import { currentParams, nav, replaceQuery, useHashParams } from '../lib/router.ts';
import { badgeOf, fmtCount, fmtDateTime, fmtDuration, fmtElapsed } from '../lib/status.ts';
import { type RunTab, tabOf, withTab } from '../lib/tabs.ts';
import { useRunDetail } from '../lib/useRunDetail.ts';

export const titleOf = (detail: RunDetail | null, id: string): string => {
  const t = (detail?.request as { form?: { title?: unknown } } | null)?.form?.title;
  return typeof t === 'string' && t ? t : (detail?.report?.title ?? id);
};

const modelOf = (detail: RunDetail | null): string | null =>
  detail?.report?.model ?? detail?.run?.model ?? ((detail?.request as { model?: unknown } | null)?.model as string | undefined) ?? null;

function Readout({ k, children, tone }: { k: string; children: ReactNode; tone?: string }) {
  return (
    <div className="readout" data-tone={tone}>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function TabPanel({ id, active, children }: { id: RunTab; active: RunTab; children: ReactNode }) {
  // Every panel stays mounted (hidden when inactive) so filters, scroll, video
  // position and live SSE state survive tab switches.
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} hidden={active !== id} className="tab-panel">
      {children}
    </div>
  );
}

export function RunDetailPage({ id }: { id: string }) {
  const data = useRunDetail(id);
  const { detail, run, phase, terminal, progress, shots, liveStatus } = data;
  const params = useHashParams();
  const tab = tabOf(params.get('tab'));
  const setTab = (t: RunTab) => replaceQuery(withTab(currentParams(), t));
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [net, setNet] = useState<{ requests: number; failed: number } | null>(null);
  const onNet = useCallback((s: { requests: number; failed: number }) => setNet(s), []);

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
  const tokens = run?.tokens ?? progress?.counters.tokens ?? null;
  const steps = run?.steps ?? progress?.counters.steps ?? null;
  const evidenceCount = groupScreenshots(report, shots).reduce((n, g) => n + g.paths.length, 0);
  const eventCount = timelineRows(data.events).length;
  const showPlan = awaiting || terminal || !(progress?.plan_steps.length ?? 0);
  const link = terminal ? 'sealed' : data.sseState === 'open' ? 'live' : 'linking';

  return (
    <div className="page run" data-tone={badge.terminal ? undefined : 'live'}>
      <header className="run-head">
        <p className="crumbs mono">
          <a href="#/" className="crumb-link">
            runs
          </a>
          <span aria-hidden="true">/</span>
          <span>{id}</span>
        </p>
        <div className="run-head-main">
          <div className="run-title">
            <h1>{titleOf(detail, id)}</h1>
            <div className="run-state">
              <StatusBadge status={statusText} testId="phase" size="lg" />
              {currentPlanStep && !terminal && <span className="mono state-step">plan step {currentPlanStep}</span>}
              <span className={`link-state link-${link}`}>
                {link === 'live' && <span className="rec-dot" aria-hidden="true" />}
                {link === 'sealed' ? 'evidence sealed' : link === 'live' ? 'live via SSE' : 'connecting to live updates'}
              </span>
            </div>
          </div>
          <div className="run-actions">
            <button type="button" className="btn danger" disabled={terminal || actionBusy} onClick={() => void act('cancel')}>
              Cancel
            </button>
            <button type="button" className="btn" disabled={actionBusy} onClick={() => void act('rerun')}>
              Rerun
            </button>
          </div>
        </div>
        <dl className="readouts">
          <Readout k="Model">{modelOf(detail) ?? '—'}</Readout>
          <Readout k="Started">{fmtDateTime(run?.started_at ?? null)}</Readout>
          <Readout k="Duration">
            {run ? fmtDuration(run.started_at ?? null, run.ended_at ?? null) : fmtElapsed(progress?.counters.elapsed_s)}
          </Readout>
          <Readout k="Steps">{steps ?? '—'}</Readout>
          <Readout k="Tokens in/out">{tokens ? `${fmtCount(tokens.input ?? 0)} / ${fmtCount(tokens.output ?? 0)}` : '—'}</Readout>
          <Readout k="Exit" tone={run?.exit_code ? 'bad' : undefined}>
            {run?.exit_code ?? '—'}
          </Readout>
          <Readout k="Egress denied" tone={egress?.denied.length ? 'bad' : undefined}>
            {egress ? egress.denied.reduce((n, d) => n + d.count, 0) : '—'}
          </Readout>
          <Readout k="Chrome">{run?.chrome_version ?? report?.chrome_version ?? '—'}</Readout>
        </dl>
      </header>

      {error && <Banner tone="bad">{error}</Banner>}
      {awaiting && (
        <Banner tone="warn">
          <strong>Awaiting approval.</strong> The agent has planned this run and is paused. Review the plan below.
        </Banner>
      )}

      <Tabs
        label="Run panels"
        active={tab}
        onSelect={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'evidence', label: 'Evidence', count: evidenceCount },
          { id: 'timeline', label: 'Timeline', count: eventCount },
          { id: 'network', label: 'Network', count: net?.requests ?? null, alert: (net?.failed ?? 0) > 0 },
          { id: 'artifacts', label: 'Artifacts' },
        ]}
      />

      <TabPanel id="overview" active={tab}>
        {!terminal && (
          <>
            <div className="monitor">
              <LiveFeed runId={id} shot={latestShot} label={currentPlanStep ?? badge.text} awaiting={awaiting} />
              <LiveProgress progress={progress} fallbackPhase={phase} plan={detail?.plan ?? null} />
            </div>
            {!awaiting && <StepLog progress={progress} />}
          </>
        )}
        <VerdictPanel runId={id} report={report} run={run} />
        <VideoPanel runId={id} data={data.chapters} />
        <CriteriaPanel runId={id} report={report} />
        {showPlan && (
          <PlanPanel
            plan={detail?.plan ?? null}
            reportSteps={report?.plan?.steps}
            liveSteps={progress?.plan_steps}
            currentStep={terminal ? null : currentPlanStep}
            editable={awaiting}
            onApprove={onApprove}
            onReject={onReject}
          />
        )}
      </TabPanel>
      <TabPanel id="evidence" active={tab}>
        <Gallery runId={id} report={report} names={shots} />
      </TabPanel>
      <TabPanel id="timeline" active={tab}>
        <Timeline events={data.events} maxRows={terminal ? undefined : 200} />
      </TabPanel>
      <TabPanel id="network" active={tab}>
        {detail ? <NetworkPanel runId={id} live={!terminal} onSummary={onNet} /> : <p className="empty">Loading…</p>}
      </TabPanel>
      <TabPanel id="artifacts" active={tab}>
        <div className="split">
          <EgressPanel egress={egress} />
          {detail && <ArtifactsPanel runId={id} />}
        </div>
      </TabPanel>
    </div>
  );
}
