import fs from 'node:fs';
import type { Size } from '../../events.ts';
import type { AgentAction } from '../actions.ts';
import type { ModelClient, ModelReply, NextInput, StructuredInput } from '../contract.ts';
import { resizedSize, TIER_HIGH, TIER_STANDARD } from './anthropic.ts';
import { imageSizeOpenAI } from './openai.ts';

type StubTurnAction = (AgentAction | (Record<string, unknown> & { point_from_screen?: { x: number; y: number } })) & {
  point_from_screen?: { x: number; y: number };
};
type StubTurn = { action: StubTurnAction; sleep_ms?: number };

export type ImageSizeFrom = 'anthropic:standard' | 'anthropic:high' | 'openai' | 'screen';
type StubScript = { turns: StubTurn[]; image_size?: Size; image_size_from?: ImageSizeFrom; plan?: unknown; evaluation?: unknown };

const DONE: AgentAction = { kind: 'done', status: 'PASSED', summary: 'script exhausted' };

/**
 * Stub-only script features:
 * - `image_size_from` (script level): pick the image space a real provider would use, so a
 *   scripted `click_at` exercises the same resize + coordinate mapping as that provider.
 * - `point_from_screen` (turn level, on click_at/scroll actions): give the target in
 *   SCREEN pixels; the stub converts it into the configured image space, so the loop's
 *   imageToScreen maps it back onto the same screen point.
 * - `ref_for` (turn level): resolved by the loop against the aria snapshot (stub models only).
 */
export class StubClient implements ModelClient {
  readonly id: string;
  private readonly script: StubScript;
  private readonly screen: Size;
  private i = 0;

  constructor(opts: { scriptPath: string; screen: Size }) {
    this.script = JSON.parse(fs.readFileSync(opts.scriptPath, 'utf8')) as StubScript;
    this.screen = opts.screen;
    this.id = `stub/${opts.scriptPath}`;
  }

  imageSize(screen: Size): Size {
    if (this.script.image_size) return this.script.image_size;
    switch (this.script.image_size_from) {
      case 'anthropic:standard':
        return resizedSize(screen.width, screen.height, TIER_STANDARD.maxEdge, TIER_STANDARD.maxTokens);
      case 'anthropic:high':
        return resizedSize(screen.width, screen.height, TIER_HIGH.maxEdge, TIER_HIGH.maxTokens);
      case 'openai':
        return imageSizeOpenAI(screen.width, screen.height);
      default:
        return screen;
    }
  }

  private imageSpace(p: { x: number; y: number }): { x: number; y: number } {
    const img = this.imageSize(this.screen);
    return { x: Math.round((p.x * img.width) / this.screen.width), y: Math.round((p.y * img.height) / this.screen.height) };
  }

  /**
   * Stub structured calls: the script may carry "plan" / "evaluation" returned verbatim for
   * the planner/evaluator calls (matched by schema name). Missing values get deterministic
   * defaults: a plan synthesized from the turns' plan_step/criterion ids, an evaluation with
   * every criterion MET and no issues.
   */
  private defaultPlan(): unknown {
    const steps: string[] = [];
    const criteria: string[] = [];
    for (const t of this.script.turns) {
      const a = t.action as Record<string, unknown>;
      if (typeof a.plan_step === 'string' && !steps.includes(a.plan_step)) steps.push(a.plan_step);
      if (typeof a.criterion === 'string' && !criteria.includes(a.criterion)) criteria.push(a.criterion);
    }
    return {
      title: 'stub plan',
      steps: (steps.length ? steps : ['p1']).map((id) => ({ id, intent: `Plan step ${id}`, expected: 'step completed' })),
      criteria: (criteria.length ? criteria : ['c1']).map((id) => ({ id, description: `Criterion ${id}` })),
    };
  }

  private defaultEvaluation(): unknown {
    const plan = (this.script.plan ?? this.defaultPlan()) as { criteria?: { id: string }[] };
    return {
      criteria: (plan.criteria ?? []).map((c) => ({ id: c.id, status: 'MET', evidence: 'stub evidence', screenshots: [] })),
      issues: [],
      conclusions: 'stub evaluation: everything passed',
    };
  }

  async structured(input: StructuredInput): Promise<ModelReply> {
    const zero = { input_tokens: 0, output_tokens: 0 };
    if (input.name === 'agent_plan') {
      // null = "no plan": legacy scripts (no plan field, no plan_step ids) keep §6 behaviour.
      const hasPlanIds = this.script.turns.some((t) => typeof (t.action as Record<string, unknown>).plan_step === 'string');
      return { raw: this.script.plan ?? (hasPlanIds ? this.defaultPlan() : null), usage: zero };
    }
    if (input.name === 'agent_eval') return { raw: this.script.evaluation ?? this.defaultEvaluation(), usage: zero };
    throw new Error(`stub: no response for structured call '${input.name}'`);
  }

  async next(_input: NextInput): Promise<ModelReply> {
    const turns = this.script.turns;
    const turn: StubTurn = turns.length ? turns[Math.min(this.i, turns.length - 1)] : { action: DONE };
    this.i += 1;
    if (turn.sleep_ms) await new Promise((r) => setTimeout(r, turn.sleep_ms));
    let action = turn.action as Record<string, unknown>;
    if (action.kind !== 'done' && !('plan_step' in action)) action = { ...action, plan_step: null };
    if ((action.kind as string).startsWith('assert_') && !('criterion' in action)) action = { ...action, criterion: null };
    if (action.point_from_screen) {
      const p = this.imageSpace(action.point_from_screen as { x: number; y: number });
      action = { ...action, x: p.x, y: p.y };
      delete action.point_from_screen;
    }
    return { raw: { action }, usage: { input_tokens: 0, output_tokens: 0 } };
  }
}
