import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { errors } from 'playwright-core';
import { Budget, BudgetExceeded } from './agent/budget.ts';
import { type AgentOutcome, resizePng, runAgent } from './agent/loop.ts';
import { createModel } from './agent/model.ts';
import type { Evaluation, Plan } from './agent/plan.ts';
import { parsePlan } from './agent/plan.ts';
import { runEvaluator, runPlanner } from './agent/planner.ts';
import { computePlanVerdict, computeVerdict, exitCode, exitCode15 } from './agent/verdict.ts';
import { type Expectation, isAllowedOrigin, loadConfig, loadTestSpec } from './config.ts';
import { Cursor } from './cursor.ts';
import { summarizeAccessLog } from './egress.ts';
import type { RunStatus, Status } from './events.ts';
import { EventLog } from './events.ts';
import { InteractionEngine } from './interaction.ts';
import { NetworkLog } from './network.ts';
import type { Chapter } from './postprocess/chapters.ts';
import { runPostprocess } from './postprocess/render.ts';
import { ScreenRecorder } from './recorder.ts';
import { buildReportJson, renderReportHtml, renderReportMd } from './report/report.ts';
import { loadSecrets, redact } from './secrets.ts';
import { Session } from './session.ts';

const CONTROL_DIR = process.env.CONTROL_DIR ?? '/control';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function evalExpectations(page: Page, expects: Expectation[]): Promise<boolean[]> {
  const out: boolean[] = [];
  for (const e of expects) {
    try {
      if (e.kind === 'url') out.push(new RegExp(e.matches).test(page.url()));
      else if (e.kind === 'visible') {
        const el = page.getByRole(e.role as Parameters<Page['getByRole']>[0], { name: e.name, exact: true });
        await el.waitFor({ state: 'visible', timeout: 5_000 }).catch((err) => {
          if (!(err instanceof errors.TimeoutError)) throw err;
        });
        out.push(await el.isVisible());
      } else {
        const el = page.getByRole(e.role as Parameters<Page['getByRole']>[0], { name: e.name, exact: true });
        await el.waitFor({ state: 'visible', timeout: 5_000 }).catch((err) => {
          if (!(err instanceof errors.TimeoutError)) throw err;
        });
        // biome-ignore lint/performance/useDomNodeTextContent: innerText is the visible text the spec requires
        out.push((await el.isVisible().catch(() => false)) && (await el.innerText().catch(() => '')).includes(e.contains));
      }
    } catch (err) {
      if (err instanceof errors.TimeoutError) out.push(false);
      else out.push(false);
    }
  }
  return out;
}

/** Compact action log for the evaluator: step id, label, plan step, result, error (§15.4). */
function stepLogText(
  events: { type: string; step_id?: string; label?: string; plan_step?: string | null; status?: string; error?: string }[],
): string {
  const ends = new Map<string, { status?: string; error?: string }>();
  const lines: string[] = [];
  for (const e of events) {
    if (e.type === 'ACTION_END' && e.step_id) ends.set(e.step_id, { status: e.status, error: e.error });
    if (e.type === 'ACTION_START' && e.step_id) lines.push(`${e.step_id} ${e.plan_step ?? '-'} "${e.label}"`);
  }
  return lines
    .map((l) => {
      const id = l.split(' ')[0];
      const end = ends.get(id);
      return `${l} -> ${end?.status ?? 'open'}${end?.error ? ` (${end.error})` : ''}`;
    })
    .join('\n');
}

async function main(): Promise<number> {
  const cfg = loadConfig();
  const spec = loadTestSpec(cfg.testFile);
  const runDir = path.join(cfg.artifactRoot, cfg.runId);
  fs.mkdirSync(runDir, { recursive: false }); // fails if it exists
  fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
  if (spec.secrets) loadSecrets(Object.keys(spec.secrets));
  const assetsDir = path.join(path.dirname(cfg.testFile), 'assets');
  const controlDir = CONTROL_DIR;
  const cancelled = () => {
    try {
      return fs.existsSync(path.join(controlDir, 'cancel'));
    } catch {
      return false;
    }
  };

  const writeStatus = (phase: string, planStep: string | null = null, stepId: string | null = null) => {
    const p = path.join(runDir, 'status.json');
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ phase, plan_step: planStep, step_id: stepId, updated_at: new Date().toISOString() }));
    fs.renameSync(tmp, p);
  };

  const startedAt = new Date().toISOString();
  const log = new EventLog(path.join(runDir, 'events.jsonl'));
  const network = new NetworkLog(path.join(runDir, 'network.jsonl'));
  const recorder = new ScreenRecorder({ display: cfg.display, width: cfg.screen.width, height: cfg.screen.height, fps: 30 });
  const budget = new Budget({ timeout_s: spec.timeout_s, max_model_tokens: spec.max_model_tokens });

  let status: RunStatus = 'FAILED';
  let summary = '';
  let harnessError = false;
  let chromeVersion = 'unknown';
  let tokens = { input_tokens: 0, output_tokens: 0 };
  let outcome: AgentOutcome = { claimed: 'FAILED', summary: 'not run' };
  let budgetExceeded = false;
  let session: Session | null = null;
  let plan: Plan | null = null;
  const planStatus: Record<string, string> = {};
  const stepNotes: Record<string, string> = {};
  const assertions: { step_id: string; label: string; criterion: string | null; passed: boolean }[] = [];
  const stepDones: { plan_step: string; status: Status; notes?: string }[] = [];
  const stepShots = new Map<string, string>();
  let evaluation: Evaluation | null = null;
  let expectResults: boolean[] | null = null;
  const model = createModel(cfg);

  writeStatus('planning');
  try {
    // §15.2: the planner runs before the browser connects; no page content is involved.
    try {
      plan = await runPlanner(model, spec);
    } catch (err) {
      throw new Error(`Planner error: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (plan) {
      for (const s of plan.steps) planStatus[s.id] = 'open';
      fs.writeFileSync(path.join(runDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    }

    // §15.2 approval gate.
    if (spec.review_plan && plan) {
      writeStatus('awaiting_approval');
      const timeoutMs = (spec.approval_timeout_s ?? 1800) * 1000;
      const deadline = Date.now() + timeoutMs;
      const approvalFile = path.join(controlDir, 'approval.json');
      let decided = false;
      while (Date.now() < deadline) {
        try {
          const approval = JSON.parse(fs.readFileSync(approvalFile, 'utf8')) as { decision?: string; plan?: unknown };
          if (approval.decision === 'approve') {
            if (approval.plan) {
              plan = parsePlan(approval.plan); // validated again (§15.2)
              for (const s of plan.steps) if (!(s.id in planStatus)) planStatus[s.id] = 'open';
              fs.writeFileSync(path.join(runDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
            }
            decided = true;
            break;
          }
          if (approval.decision === 'reject') {
            status = 'CANCELLED';
            summary = 'Plan rejected';
            decided = true;
            break;
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
        }
        if (cancelled()) {
          status = 'CANCELLED';
          summary = 'Run cancelled while awaiting approval';
          decided = true;
          break;
        }
        await sleep(1000);
      }
      if (!decided) {
        status = 'CANCELLED';
        summary = 'Plan approval timed out';
      }
    }

    if (status !== 'CANCELLED') {
      writeStatus('running');
      try {
        session = await Session.connect(cfg.cdpUrl, cfg.screen, spec.allowed_origins, (u) => isAllowedOrigin(u, spec), network);
        chromeVersion = session.browser.version();
        log.emit({
          type: 'RUN_START',
          run_id: cfg.runId,
          test: spec.name,
          screen: cfg.screen,
          chrome_version: chromeVersion,
          model: model.id,
        });

        const videoStartMs = await recorder.start(path.join(runDir, 'raw.mkv'), path.join(runDir, 'logs', 'ffmpeg-record.log'));
        log.emit({ type: 'RECORDING_START', file: 'raw.mkv', video_start_ms: videoStartMs });

        const cursor = new Cursor(cfg.screen);
        const engine = new InteractionEngine({ session, cursor, log, screen: cfg.screen, isAllowedUrl: (u) => isAllowedOrigin(u, spec) });

        try {
          await engine.navigate('s0000', `Open ${spec.name}`, spec.start_url);
          outcome = await runAgent({
            engine,
            session,
            log,
            model,
            spec,
            budget,
            screen: cfg.screen,
            runDir,
            plan: plan ?? undefined,
            planStatus,
            assetsDir: fs.existsSync(assetsDir) ? assetsDir : undefined,
            cancelled,
            assertions,
            stepDones,
            stepShots,
          });
        } catch (err) {
          if (err instanceof BudgetExceeded) {
            budgetExceeded = true;
            outcome = { claimed: 'FAILED', summary: err.message };
          } else {
            outcome = { claimed: 'FAILED', summary: `Harness error: ${redact(err instanceof Error ? err.message : String(err))}` };
            harnessError = true;
          }
        }
        tokens = { input_tokens: budget.usage.input, output_tokens: budget.usage.output };
        if (outcome.cancelled) {
          status = 'CANCELLED';
          summary = outcome.summary;
        }
        if (session.violation && !harnessError) {
          outcome = { claimed: 'FAILED', summary: session.violation };
          harnessError = true;
        }

        // Expectations + final screenshot + evaluator + verdict, all while the log is still open.
        if (session && spec.expect && status !== 'CANCELLED' && !harnessError) {
          expectResults = await evalExpectations(session.page, spec.expect).catch(() => [false]);
        }
        if (session && status !== 'CANCELLED' && !harnessError) {
          try {
            const shot = await session.page.screenshot();
            const imageSize = model.imageSize(cfg.screen);
            const png =
              imageSize.width === cfg.screen.width && imageSize.height === cfg.screen.height ? shot : await resizePng(shot, imageSize);
            fs.mkdirSync(path.join(runDir, 'screenshots'), { recursive: true });
            fs.writeFileSync(path.join(runDir, 'screenshots', 'final.png'), png);
          } catch {
            /* best effort */
          }
        }
        if (plan && status !== 'CANCELLED' && !harnessError) {
          try {
            writeStatus('evaluating');
            const evalShots: { name: string; png: Buffer }[] = [];
            for (const st of plan.steps) {
              const sp = stepShots.get(st.id);
              if (sp && evalShots.length < 7) evalShots.push({ name: path.basename(sp), png: fs.readFileSync(path.join(runDir, sp)) });
            }
            if (fs.existsSync(path.join(runDir, 'screenshots', 'final.png')) && evalShots.length < 8) {
              evalShots.push({ name: 'final.png', png: fs.readFileSync(path.join(runDir, 'screenshots', 'final.png')) });
            }
            const assertionText = assertions
              .map((a) => `${a.step_id} "${a.label}" criterion=${a.criterion ?? 'null'} -> ${a.passed ? 'PASSED' : 'FAILED'}`)
              .join('\n');
            evaluation = await runEvaluator(model, {
              spec,
              plan,
              stepLog: redact(stepLogText(log.events)),
              assertions: redact(assertionText),
              summary: redact(outcome.summary),
              screenshots: evalShots,
            });
            fs.writeFileSync(path.join(runDir, 'evaluation.json'), `${JSON.stringify(evaluation, null, 2)}\n`);
          } catch (err) {
            harnessError = true;
            status = 'FAILED';
            summary = `Evaluator error: ${redact(err instanceof Error ? err.message : String(err))}`;
          }
        }

        // Verdict (§6.4 / §15.5) — computed before RUN_END so the event carries the real status.
        if (!harnessError && status !== 'CANCELLED') {
          if (plan && evaluation) {
            status = computePlanVerdict({
              claimed: outcome.claimed,
              harnessError,
              budgetExceeded,
              assertions,
              stepDones,
              plan,
              evaluation,
              expectResults,
            });
          } else {
            status = computeVerdict({
              claimed: outcome.claimed,
              assertionFailed: outcome.assertionFailed ?? false,
              expectResults: spec.expect ? (expectResults ?? [false]) : null,
              harnessError,
              budgetExceeded,
            });
          }
          summary = outcome.summary;
        } else if (!summary && outcome.summary) {
          summary = outcome.summary; // a harness error inside the agent loop must still reach run.json
        }
      } catch (err) {
        harnessError = true;
        status = 'FAILED';
        summary = `Harness error: ${redact(err instanceof Error ? err.message : String(err))}`;
      }
    }
  } catch (err) {
    harnessError = true;
    status = 'FAILED';
    summary = `Harness error: ${redact(err instanceof Error ? err.message : String(err))}`;
  } finally {
    try {
      log.emit({ type: 'RUN_END', status, summary: redact(summary || 'not run') });
      await recorder.stop();
      log.emit({ type: 'RECORDING_STOP' });
    } finally {
      await network.close();
      await log.close();
    }
  }

  const screenshotsList: { plan_step: string | null; path: string }[] = [];

  // Egress summary + proxy log copy (§6.6).
  let egress: { allowed: number; denied: { host: string; count: number }[] } | null = null;
  try {
    const wantAgent = !cfg.agentModel.startsWith('stub/');
    let prev = -1;
    for (let i = 0; i < 25; i++) {
      let size = -1;
      let hasAgentLine = false;
      try {
        size = fs.statSync('/proxy-logs/access.log').size;
        hasAgentLine = fs.readFileSync('/proxy-logs/access.log', 'utf8').includes(':3129');
      } catch {
        /* handled below */
      }
      if (wantAgent && !hasAgentLine && i < 20) {
        prev = size;
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (size === prev && i > 1) break;
      prev = size;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const access = fs.readFileSync('/proxy-logs/access.log', 'utf8');
    fs.writeFileSync(path.join(runDir, 'logs', 'proxy-access.log'), access);
    egress = summarizeAccessLog(access);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      fs.appendFileSync(path.join(runDir, 'logs', 'harness.log'), 'WARN: /proxy-logs/access.log missing; egress summary unavailable\n');
    } else {
      harnessError = true;
      status = 'FAILED';
      summary = `Harness error: could not read proxy access log: ${redact(String(err))}`;
    }
  }

  // Post-processing, then the evaluator (§15.4) for runs with a plan.
  if (fs.existsSync(path.join(runDir, 'raw.mkv'))) {
    try {
      writeStatus('postprocessing');
      await runPostprocess(runDir);
    } catch (err) {
      harnessError = true;
      status = 'FAILED';
      summary = `Post-processing error: ${redact(err instanceof Error ? err.message : String(err))}`;
    }
  }

  // Report files (§15.6) — written for every run, plan or not.
  const endedAt = new Date().toISOString();
  const code = plan ? exitCode15(status, harnessError) : exitCode(status as Exclude<RunStatus, 'CANCELLED'>, harnessError);
  const durations = { raw_s: null as number | null, final_s: null as number | null };
  try {
    const tm = JSON.parse(fs.readFileSync(path.join(runDir, 'timemap.json'), 'utf8')) as {
      duration_raw_s?: number;
      duration_out_s?: number;
    };
    durations.raw_s = tm.duration_raw_s ?? null;
    durations.final_s = tm.duration_out_s ?? null;
  } catch {
    /* no timemap */
  }
  fs.writeFileSync(
    path.join(runDir, 'run.json'),
    `${JSON.stringify(
      {
        run_id: cfg.runId,
        test: spec.name,
        status,
        summary: redact(summary),
        exit_code: code,
        started_at: startedAt,
        ended_at: endedAt,
        chrome_version: chromeVersion,
        playwright_version: (await import('playwright-core/package.json', { with: { type: 'json' } })).default.version,
        model: cfg.agentModel,
        steps: outcome.steps ?? 0,
        tokens: { input: tokens.input_tokens, output: tokens.output_tokens },
        egress,
        durations,
      },
      null,
      2,
    )}\n`,
  );

  let chapters: Chapter[] = [];
  try {
    chapters = (JSON.parse(fs.readFileSync(path.join(runDir, 'chapters.json'), 'utf8')) as { chapters: Chapter[] }).chapters;
  } catch {
    /* no postprocess output */
  }
  for (const s of plan?.steps ?? []) {
    const p = stepShots.get(s.id);
    if (p) screenshotsList.push({ plan_step: s.id, path: p });
  }
  if (fs.existsSync(path.join(runDir, 'screenshots', 'final.png')))
    screenshotsList.push({ plan_step: null, path: 'screenshots/final.png' });
  const report = buildReportJson({
    run_id: cfg.runId,
    status,
    summary: redact(summary),
    model: cfg.agentModel,
    chrome_version: chromeVersion,
    started_at: startedAt,
    ended_at: endedAt,
    tokens: { input: tokens.input_tokens, output: tokens.output_tokens },
    egress,
    spec,
    plan,
    planStatus,
    stepNotes,
    stepDones,
    assertions,
    evaluation,
    chapters,
    screenshots: screenshotsList,
  });
  fs.writeFileSync(path.join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(runDir, 'report.md'), renderReportMd(report));
  fs.writeFileSync(path.join(runDir, 'report.html'), renderReportHtml(report));
  writeStatus('done');
  return code;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(2);
  });
