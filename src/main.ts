import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { errors } from 'playwright-core';
import { Budget, BudgetExceeded } from './agent/budget.ts';
import { type AgentOutcome, runAgent } from './agent/loop.ts';
import { createModel } from './agent/model.ts';
import { computeVerdict, exitCode } from './agent/verdict.ts';
import { type Expectation, isAllowedOrigin, loadConfig, loadTestSpec } from './config.ts';
import { Cursor } from './cursor.ts';
import { summarizeAccessLog } from './egress.ts';
import type { RunStatus } from './events.ts';
import { EventLog } from './events.ts';
import { InteractionEngine } from './interaction.ts';
import { runPostprocess } from './postprocess/render.ts';
import { ScreenRecorder } from './recorder.ts';
import { loadSecrets, redact } from './secrets.ts';
import { Session } from './session.ts';

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

async function main(): Promise<number> {
  const cfg = loadConfig();
  const spec = loadTestSpec(cfg.testFile);
  const runDir = path.join(cfg.artifactRoot, cfg.runId);
  fs.mkdirSync(runDir, { recursive: false }); // fails if it exists
  fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
  if (spec.secrets) loadSecrets(Object.keys(spec.secrets));

  const startedAt = new Date().toISOString();
  const log = new EventLog(path.join(runDir, 'events.jsonl'));
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

  try {
    session = await Session.connect(cfg.cdpUrl, cfg.screen, spec.allowed_origins, (u) => isAllowedOrigin(u, spec));
    chromeVersion = session.browser.version();
    const model = createModel(cfg);
    log.emit({ type: 'RUN_START', run_id: cfg.runId, test: spec.name, screen: cfg.screen, chrome_version: chromeVersion, model: model.id });

    const videoStartMs = await recorder.start(path.join(runDir, 'raw.mkv'), path.join(runDir, 'logs', 'ffmpeg-record.log'));
    log.emit({ type: 'RECORDING_START', file: 'raw.mkv', video_start_ms: videoStartMs });

    const cursor = new Cursor(cfg.screen);
    const engine = new InteractionEngine({ session, cursor, log, screen: cfg.screen, isAllowedUrl: (u) => isAllowedOrigin(u, spec) });

    try {
      await engine.navigate('s0000', `Open ${spec.name}`, spec.start_url);
      outcome = await runAgent({ engine, session, log, model, spec, budget, screen: cfg.screen, runDir });
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        budgetExceeded = true;
        outcome = { claimed: 'FAILED', summary: err.message };
        tokens = { input_tokens: budget.usage.input, output_tokens: budget.usage.output };
      } else {
        outcome = { claimed: 'FAILED', summary: `Harness error: ${redact(err instanceof Error ? err.message : String(err))}` };
        harnessError = true;
      }
    }
    tokens = { input_tokens: budget.usage.input, output_tokens: budget.usage.output };
    if (session.violation && !harnessError) {
      outcome = { claimed: 'FAILED', summary: session.violation };
      harnessError = true;
    }

    const expectResults = spec.expect ? await evalExpectations(session.page, spec.expect).catch(() => [false]) : null;
    status = computeVerdict({
      claimed: outcome.claimed,
      assertionFailed: outcome.assertionFailed ?? false,
      expectResults,
      harnessError,
      budgetExceeded,
    });
    summary = outcome.summary;
  } catch (err) {
    harnessError = true;
    status = 'FAILED';
    summary = `Harness error: ${redact(err instanceof Error ? err.message : String(err))}`;
  } finally {
    try {
      log.emit({ type: 'RUN_END', status, summary: redact(summary) });
      await recorder.stop();
      log.emit({ type: 'RECORDING_STOP' });
    } finally {
      await log.close();
    }
  }

  // Egress summary + run.json (§6.6).
  fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
  let egress: { allowed: number; denied: { host: string; count: number }[] } | null = null;
  try {
    // Squid logs CONNECT tunnels when they close; the model API tunnel is kept
    // alive across steps and only closes after the last request — wait for the
    // log to stop growing so late lines are captured.
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

  if (fs.existsSync(path.join(runDir, 'raw.mkv'))) {
    try {
      await runPostprocess(runDir);
    } catch (err) {
      harnessError = true;
      status = 'FAILED';
      summary = `Post-processing error: ${redact(err instanceof Error ? err.message : String(err))}`;
    }
  }

  const code = exitCode(status, harnessError);
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
        ended_at: new Date().toISOString(),
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
  return code;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(2);
  });
