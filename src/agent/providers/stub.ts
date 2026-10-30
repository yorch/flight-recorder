import fs from 'node:fs';
import type { TestSpec } from '../../config.ts';
import type { Size } from '../../events.ts';
import type { AgentAction } from '../actions.ts';
import type { ModelClient, ModelReply, Observation, StepRecord } from '../contract.ts';
import { resizedSize, TIER_HIGH, TIER_STANDARD } from './anthropic.ts';
import { imageSizeOpenAI } from './openai.ts';

type StubTurnAction = (AgentAction | (Record<string, unknown> & { point_from_screen?: { x: number; y: number } })) & {
  point_from_screen?: { x: number; y: number };
};
type StubTurn = { action: StubTurnAction; sleep_ms?: number };

export type ImageSizeFrom = 'anthropic:standard' | 'anthropic:high' | 'openai' | 'screen';
type StubScript = { turns: StubTurn[]; image_size?: Size; image_size_from?: ImageSizeFrom };

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

  async next(_input: { spec: TestSpec; observation: Observation; history: StepRecord[]; schema: object }): Promise<ModelReply> {
    const turns = this.script.turns;
    const turn: StubTurn = turns.length ? turns[Math.min(this.i, turns.length - 1)] : { action: DONE };
    this.i += 1;
    if (turn.sleep_ms) await new Promise((r) => setTimeout(r, turn.sleep_ms));
    let action = turn.action as Record<string, unknown>;
    if (action.point_from_screen) {
      const p = this.imageSpace(action.point_from_screen as { x: number; y: number });
      action = { ...action, x: p.x, y: p.y };
      delete action.point_from_screen;
    }
    return { raw: { action }, usage: { input_tokens: 0, output_tokens: 0 } };
  }
}
