import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { TestSpec } from '../config.ts';
import type { EventLog, Size, Status } from '../events.ts';
import type { InteractionEngine } from '../interaction.ts';
import { AssertionFailure } from '../interaction.ts';
import { redact, resolvePlaceholders } from '../secrets.ts';
import type { Session } from '../session.ts';
import { type AgentAction, AgentTurn, agentTurnJsonSchema, normalizeEnums, toWireSchema } from './actions.ts';
import type { Budget } from './budget.ts';
import type { ModelClient, Observation, StepRecord } from './contract.ts';
import { imageToScreen } from './coords.ts';

const MAX_CONSECUTIVE_FAILURES = 3;
const HISTORY_WINDOW = 12;

export interface AgentContext {
  engine: InteractionEngine;
  session: Session;
  log: EventLog;
  model: ModelClient;
  spec: TestSpec;
  budget: Budget;
  screen: Size;
  runDir: string; // artifacts/<run_id>
}

export interface AgentOutcome {
  claimed: Status;
  summary: string;
  assertionFailed?: boolean;
  steps?: number;
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
  const shot = await page.screenshot();
  const png = imageSize.width === ctx.screen.width && imageSize.height === ctx.screen.height ? shot : await resizePng(shot, imageSize);
  obs.screenshot = { png, width: imageSize.width, height: imageSize.height };
  fs.mkdirSync(path.join(ctx.runDir, 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(ctx.runDir, 'screenshots', `${stepId}.png`), png);
  obs.aria_snapshot = await page.ariaSnapshot({ mode: 'ai' }).catch(() => undefined);
  return obs;
}

async function execute(ctx: AgentContext, stepId: string, action: AgentAction): Promise<void> {
  const { engine, spec, screen, model } = ctx;
  const imageSize = model.imageSize(screen);
  switch (action.kind) {
    case 'navigate':
      return engine.navigate(stepId, action.label, action.url);
    case 'click':
      return engine.click(stepId, action.label, action.ref);
    case 'click_at':
      return engine.clickAt(stepId, action.label, imageToScreen({ x: action.x, y: action.y }, imageSize, screen));
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
      return engine.type(stepId, action.label, action.ref, action.text, action.mode, resolve);
    }
    case 'press':
      return engine.press(stepId, action.label, action.key);
    case 'scroll':
      return engine.scroll(stepId, action.label, imageToScreen({ x: action.x, y: action.y }, imageSize, screen), action.dy);
    case 'dialog':
      return engine.respondToDialog(stepId, action.label, action.accept, action.prompt_text ?? undefined);
    case 'assert_visible':
      return engine.assertVisible(stepId, action.label, action.role, action.name);
    case 'assert_text':
      return engine.assertText(stepId, action.label, action.role, action.name, action.contains);
    case 'assert_visual':
      return engine.recordVerdict(stepId, action.label, action.verdict, action.reasoning);
    case 'done':
      return;
  }
}

export async function runAgent(ctx: AgentContext): Promise<AgentOutcome> {
  const { log, model, spec, budget } = ctx;
  const history: StepRecord[] = [];
  let failures = 0;
  fs.mkdirSync(path.join(ctx.runDir, 'agent'), { recursive: true });
  const transcript = fs.createWriteStream(path.join(ctx.runDir, 'agent', 'transcript.jsonl'), { flags: 'wx' });

  try {
    for (let n = 1; n <= (spec.max_steps ?? 40); n++) {
      budget.check(); // throws BudgetExceeded (wall clock, tokens)
      if (ctx.session.violation) throw new Error(`Session violation: ${ctx.session.violation}`);
      const stepId = `s${String(n).padStart(4, '0')}`;
      log.emit({ type: 'THINKING_START', step_id: stepId });
      const started = Date.now();
      const observation = await observe(ctx, stepId);
      const reply = await model.next({
        spec,
        observation,
        history: history.slice(-HISTORY_WINDOW),
        schema: toWireSchema(agentTurnJsonSchema) as object,
      });
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
      const rewired =
        normalized !== null && typeof normalized === 'object' && !Array.isArray(normalized) && 'action' in normalized
          ? {
              ...(normalized as Record<string, unknown>),
              action: resolveRefFor((normalized as { action: unknown }).action, observation.aria_snapshot),
            }
          : normalized;
      const parsed = AgentTurn.safeParse(rewired);
      log.emit({ type: 'THINKING_END', step_id: stepId });

      if (!parsed.success) {
        history.push({ step_id: stepId, result: 'FAILED', error: `Invalid action: ${parsed.error.message}` });
        if (++failures >= MAX_CONSECUTIVE_FAILURES) return { claimed: 'FAILED', summary: 'Agent produced invalid actions', steps: n };
        continue;
      }
      const { action } = parsed.data;
      if (action.kind === 'done') return { claimed: action.status, summary: action.summary, steps: n };

      try {
        await execute(ctx, stepId, action);
        history.push({ step_id: stepId, action, result: 'PASSED' });
        failures = 0;
      } catch (err) {
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
