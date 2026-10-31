import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { TestSpec } from '../config.ts';
import type { EventLog, Size, Status } from '../events.ts';
import type { InteractionEngine } from '../interaction.ts';
import { AssertionFailure } from '../interaction.ts';
import { redact, resolvePlaceholders } from '../secrets.ts';
import type { Session } from '../session.ts';
import { type AgentAction, AgentTurn, agentWireSchema, normalizeEnums } from './actions.ts';
import type { Budget } from './budget.ts';
import type { ModelClient, NextInput, Observation, StepRecord } from './contract.ts';
import { imageToScreen } from './coords.ts';
import type { Plan } from './plan.ts';

const MAX_CONSECUTIVE_FAILURES = 3;
const HISTORY_WINDOW = 12;
const MAX_FINISH_NUDGES = 2;

/**
 * §15.3 finish nudge: done:PASSED is not accepted while a criterion lacks a PASSED
 * harness assertion naming it. At most MAX_FINISH_NUDGES reminders; a third
 * done:PASSED with gaps is accepted and the run ends UNVERIFIED (§15.5).
 */
export function finishNudge(
  criteria: { id: string; description: string }[],
  assertions: { criterion: string | null; passed: boolean }[],
  nudges: number,
): { decision: 'nudge' | 'accept'; unproven: { id: string; description: string }[] } {
  const proven = new Set(assertions.filter((a) => a.passed).map((a) => a.criterion));
  const unproven = criteria.filter((c) => !proven.has(c.id));
  return { decision: unproven.length > 0 && nudges < MAX_FINISH_NUDGES ? 'nudge' : 'accept', unproven };
}

export interface AgentContext {
  engine: InteractionEngine;
  session: Session;
  log: EventLog;
  model: ModelClient;
  spec: TestSpec;
  budget: Budget;
  screen: Size;
  runDir: string; // artifacts/<run_id>
  plan?: Plan;
  planStatus?: Record<string, string>;
  /** Directory holding declared upload assets (resolved names map to files here). */
  assetsDir?: string;
  /** Returns true when the control plane asked to cancel (checked before each step). */
  cancelled?: () => boolean;
  /** Verdict/evaluator bookkeeping, filled in by runAgent. */
  assertions: { step_id: string; label: string; criterion: string | null; passed: boolean }[];
  stepDones: { plan_step: string; status: Status }[];
  /** plan step id -> last observation screenshot path (relative), for the evaluator. */
  stepShots: Map<string, string>;
}

export interface AgentOutcome {
  claimed: Status;
  summary: string;
  assertionFailed?: boolean;
  steps?: number;
  cancelled?: boolean;
}

/** Resizes a PNG buffer via ffmpeg (stdin/stdout) when the model needs a different size. */
export async function resizePng(png: Buffer, to: Size): Promise<Buffer> {
  return execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'png_pipe',
      '-i',
      '-',
      '-vf',
      `scale=${to.width}:${to.height}`,
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      '-',
    ],
    { input: png, maxBuffer: 64 * 1024 * 1024 },
  );
}

/**
 * Stub-only feature: a script turn may carry `"ref_for": {"role": "...", "name": "..."}`
 * instead of `ref`; the loop resolves it to the ref of the matching aria-snapshot line
 * (`- <role> "<name>" ... [ref=eN]`). Returns the rewritten raw action object.
 */
export function resolveRefFor(raw: unknown, ariaSnapshot: string | undefined): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  const refFor = obj.ref_for as { role?: string; name?: string } | undefined;
  if (!refFor) return raw;
  const out = { ...obj };
  delete out.ref_for;
  if (ariaSnapshot) {
    for (const line of ariaSnapshot.split('\n')) {
      const m = /^-\s+(\S+)\s+"([^"]+)"(?:.*)\[ref=([a-z0-9]+)\]\s*$/.exec(line.trim());
      if (m && m[1] === refFor.role && m[2] === refFor.name) {
        out.ref = m[3];
        return out;
      }
    }
  }
  out.ref = 'e0'; // unresolved: will fail validation as a stale ref
  return out;
}

async function observe(ctx: AgentContext, stepId: string): Promise<Observation> {
  const page = ctx.session.page;
  const obs: Observation = { step_id: stepId, url: page.url(), title: await page.title().catch(() => '') };
  const dialog = ctx.session.dialog;
  if (dialog) {
    obs.dialog = {
      type: dialog.type() as 'alert' | 'confirm' | 'prompt',
      message: dialog.message(),
      default_value: dialog.defaultValue(),
    };
    return obs; // while a dialog is open: no screenshot, no snapshot
  }
  const imageSize = ctx.model.imageSize(ctx.screen);
  const shot = await page.screenshot().catch(async (err) => {
    await new Promise((r) => setTimeout(r, 300)); // transient: page mid-navigation
    try {
      return await page.screenshot();
    } catch {
      throw err;
    }
  });
  const png = imageSize.width === ctx.screen.width && imageSize.height === ctx.screen.height ? shot : await resizePng(shot, imageSize);
  obs.screenshot = { png, width: imageSize.width, height: imageSize.height };
  fs.mkdirSync(path.join(ctx.runDir, 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(ctx.runDir, 'screenshots', `${stepId}.png`), png);
  obs.aria_snapshot = await page.ariaSnapshot({ mode: 'ai' }).catch(() => undefined);
  return obs;
}

function assetPaths(ctx: AgentContext, files: string[]): string[] {
  const dir = ctx.assetsDir;
  if (!dir) throw new Error('upload: no assets directory is configured for this run');
  const declared = ctx.spec.assets ?? [];
  const dirReal = fs.realpathSync(dir);
  return files.map((f) => {
    if (!declared.includes(f)) throw new Error(`upload: '${f}' is not a declared asset`);
    if (/[/\\]/.test(f) || f.includes('\0') || f === '..' || f === '.') throw new Error(`upload: invalid file name '${f}'`);
    const abs = path.join(dirReal, f);
    const real = fs.realpathSync(abs); // throws if missing
    if (!real.startsWith(`${dirReal}${path.sep}`)) throw new Error(`upload: '${f}' escapes the assets directory`);
    if (!fs.statSync(real).isFile()) throw new Error(`upload: '${f}' is not a regular file`);
    return real;
  });
}

async function execute(ctx: AgentContext, stepId: string, action: AgentAction): Promise<void> {
  const { engine, spec, screen, model } = ctx;
  const imageSize = model.imageSize(screen);
  const ps = 'plan_step' in action ? action.plan_step : null;
  if (ctx.plan && ps !== null && !ctx.plan.steps.some((st) => st.id === ps)) throw new Error(`plan_step '${ps}' is not in the plan`);
  switch (action.kind) {
    case 'navigate':
      return engine.navigate(stepId, action.label, action.url, ps);
    case 'click':
      return engine.click(stepId, action.label, action.ref, ps);
    case 'click_at':
      return engine.clickAt(stepId, action.label, imageToScreen({ x: action.x, y: action.y }, imageSize, screen), ps);
    case 'type': {
      const hasSecret = /\{\{secret:[A-Za-z0-9_]+\}\}/.test(action.text);
      const resolve = hasSecret
        ? async (el: Parameters<typeof resolvePlaceholders>[2] extends never ? never : import('playwright-core').Locator) =>
            resolvePlaceholders(
              action.text,
              spec,
              await el.evaluate((e) => ({ origin: location.origin, inputType: (e as HTMLInputElement).type ?? '' })),
            )
        : undefined;
      return engine.type(stepId, action.label, action.ref, action.text, action.mode, resolve, ps);
    }
    case 'press':
      return engine.press(stepId, action.label, action.key, ps);
    case 'scroll':
      return engine.scroll(stepId, action.label, imageToScreen({ x: action.x, y: action.y }, imageSize, screen), action.dy, ps);
    case 'dialog':
      return engine.respondToDialog(stepId, action.label, action.accept, action.prompt_text ?? undefined, ps);
    case 'assert_visible':
      return engine.assertVisible(stepId, action.label, action.role, action.name, 5_000, ps);
    case 'assert_text':
      return engine.assertText(stepId, action.label, action.role, action.name, action.contains, 5_000, ps);
    case 'assert_url':
      return engine.assertUrl(stepId, action.label, action.matches, ps);
    case 'assert_visual':
      return engine.recordVerdict(stepId, action.label, action.verdict, action.reasoning, ps);
    case 'step_done':
      if (!action.plan_step) throw new Error('step_done requires plan_step');
      await engine.stepDone(stepId, action.label, action.plan_step, action.status, action.notes);
      if (ctx.planStatus) ctx.planStatus[action.plan_step] = action.status;
      ctx.stepDones.push({ plan_step: action.plan_step, status: action.status });
      return;
    case 'upload':
      return engine.upload(stepId, action.label, action.ref, () => assetPaths(ctx, action.files), ps);
    case 'done':
      return;
  }
}

export async function runAgent(ctx: AgentContext): Promise<AgentOutcome> {
  const { log, model, spec, budget } = ctx;
  const history: StepRecord[] = [];
  let failures = 0;
  let finishNudges = 0;
  let currentPlanStep: string | null = null;
  fs.mkdirSync(path.join(ctx.runDir, 'agent'), { recursive: true });
  const transcript = fs.createWriteStream(path.join(ctx.runDir, 'agent', 'transcript.jsonl'), { flags: 'wx' });

  try {
    for (let n = 1; n <= (spec.max_steps ?? 40); n++) {
      budget.check(); // throws BudgetExceeded (wall clock, tokens)
      if (ctx.session.violation) throw new Error(`Session violation: ${ctx.session.violation}`);
      if (ctx.cancelled?.()) return { claimed: 'FAILED', summary: 'Run cancelled', cancelled: true, steps: n - 1 };
      const stepId = `s${String(n).padStart(4, '0')}`;
      log.emit({ type: 'THINKING_START', step_id: stepId });
      const started = Date.now();
      const observation = await observe(ctx, stepId);
      const reply = await model.next({
        spec,
        observation,
        history: history.slice(-HISTORY_WINDOW),
        schema: agentWireSchema(ctx.plan),
        plan: ctx.plan,
        planStatus: ctx.planStatus,
      } satisfies NextInput);
      budget.addTokens(reply.usage);
      transcript.write(
        `${JSON.stringify({
          step_id: stepId,
          model: model.id,
          latency_ms: Date.now() - started,
          usage: reply.usage,
          observation: {
            url: redact(observation.url),
            title: redact(observation.title),
            screenshot: observation.screenshot ? `screenshots/${stepId}.png` : null,
            screenshot_size: observation.screenshot ? { width: observation.screenshot.width, height: observation.screenshot.height } : null,
            dialog: observation.dialog ?? null,
          },
          raw: JSON.parse(redact(JSON.stringify(reply.raw))),
        })}\n`,
      );
      const normalized = normalizeEnums(reply.raw);
      let rewired = normalized;
      if (normalized !== null && typeof normalized === 'object' && !Array.isArray(normalized) && 'action' in normalized) {
        const turn = normalized as Record<string, unknown>;
        let action = turn.action;
        if (action !== null && typeof action === 'object' && !Array.isArray(action)) {
          // agentWireSchema hoists label/plan_step to the turn object; fold them back so
          // AgentTurn still validates the full per-action shape. `done` has neither field.
          const a = { ...(action as Record<string, unknown>) };
          if (a.kind !== 'done') {
            a.label ??= turn.label;
            // plan_step may legitimately be null in the action (no plan) — ??= would
            // overwrite it with a missing turn field, so fill only when absent.
            if (a.plan_step === undefined) a.plan_step = turn.plan_step ?? null;
          }
          action = a;
        }
        rewired = { action: resolveRefFor(action, observation.aria_snapshot) };
      }
      const parsed = AgentTurn.safeParse(rewired);
      log.emit({ type: 'THINKING_END', step_id: stepId });

      if (!parsed.success) {
        history.push({ step_id: stepId, result: 'FAILED', error: `Invalid action: ${parsed.error.message}` });
        if (++failures >= MAX_CONSECUTIVE_FAILURES) return { claimed: 'FAILED', summary: 'Agent produced invalid actions', steps: n };
        continue;
      }
      const { action } = parsed.data;
      if (action.kind === 'done') {
        // §15.3 finish nudge: a claimed PASSED with unproven criteria is fed back as a
        // normal turn (the FAILED history entry renders in the next user text).
        if (action.status === 'PASSED' && ctx.plan) {
          const nudge = finishNudge(ctx.plan.criteria, ctx.assertions, finishNudges);
          if (nudge.decision === 'nudge') {
            finishNudges += 1;
            const list = nudge.unproven.map((c) => `${c.id} (${c.description})`).join(', ');
            history.push({
              step_id: stepId,
              action,
              result: 'FAILED',
              error: `Criteria still unproven: ${list}. Assert them on the CURRENT page state, or finish with done FAILED.`,
            });
            continue;
          }
        }
        return { claimed: action.status, summary: action.summary, steps: n };
      }
      if (ctx.plan && !('plan_step' in action && action.plan_step !== null)) {
        history.push({ step_id: stepId, action, result: 'FAILED', error: 'Action missing plan_step (required when a plan exists)' });
        if (++failures >= MAX_CONSECUTIVE_FAILURES) return { claimed: 'FAILED', summary: 'Agent produced invalid actions', steps: n };
        continue;
      }
      const ps = 'plan_step' in action ? action.plan_step : null;
      if (ps) currentPlanStep = ps;
      if (currentPlanStep && observation.screenshot) ctx.stepShots.set(currentPlanStep, `screenshots/${stepId}.png`);
      const assertion = action.kind.startsWith('assert_')
        ? { step_id: stepId, label: action.label, criterion: 'criterion' in action ? action.criterion : null, passed: false }
        : null;

      try {
        await execute(ctx, stepId, action);
        if (assertion) {
          assertion.passed = true;
          ctx.assertions.push(assertion);
        }
        history.push({ step_id: stepId, action, result: 'PASSED' });
        failures = 0;
      } catch (err) {
        if (assertion) ctx.assertions.push(assertion);
        if (err instanceof AssertionFailure) {
          return { claimed: 'FAILED', summary: `${action.label}: ${err.message}`, assertionFailed: true, steps: n };
        }
        history.push({ step_id: stepId, action, result: 'FAILED', error: redact(String(err)) });
        if (++failures >= MAX_CONSECUTIVE_FAILURES) {
          return { claimed: 'FAILED', summary: `Gave up after ${failures} consecutive failed actions`, steps: n };
        }
      }
    }
    return { claimed: 'FAILED', summary: 'Step budget exhausted', steps: spec.max_steps ?? 40 };
  } finally {
    await new Promise<void>((resolve) => transcript.end(resolve));
  }
}
