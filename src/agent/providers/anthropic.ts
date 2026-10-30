import fs from 'node:fs';
import path from 'node:path';
import type { TestSpec } from '../../config.ts';
import type { Size } from '../../events.ts';
import type { ModelClient, ModelReply, Observation, StepRecord } from '../contract.ts';
import { buildUserText, systemPromptFor } from '../prompt.ts';
import { postJson } from './http.ts';

type FetchFn = typeof fetch;

const patches = (n: number) => Math.ceil(n / 28);
const fits = (w: number, h: number, maxEdge: number, maxTokens: number) =>
  patches(w) * 28 <= maxEdge && patches(h) * 28 <= maxEdge && patches(w) * patches(h) <= maxTokens;
const rHE = (n: number) => {
  const f = Math.floor(n);
  const d = n - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1; // round half to even
};

/** Port of Anthropic's reference resizedSize: binary search on the long edge, 28-px patches. */
export function resizedSize(width: number, height: number, maxEdge: number, maxTokens: number): Size {
  if (height > width) {
    const r = resizedSize(height, width, maxEdge, maxTokens);
    return { width: r.height, height: r.width };
  }
  if (fits(width, height, maxEdge, maxTokens)) return { width, height };
  const rHU = (n: number) => Math.floor(n + 0.5); // probe uses .5-up (fits rejects on ties)
  let lo = 1;
  let hi = width;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (fits(mid, rHU((height * mid) / width), maxEdge, maxTokens)) lo = mid;
    else hi = mid - 1;
  }
  return { width: lo, height: rHE((height * lo) / width) };
}

export type ImageTier = { maxEdge: number; maxTokens: number };
export const TIER_STANDARD: ImageTier = { maxEdge: 1568, maxTokens: 1568 };
export const TIER_HIGH: ImageTier = { maxEdge: 2576, maxTokens: 4784 };

/** high iff the model id parses as claude-<family>-<major>-<minor> with (major, minor) >= (4, 7). */
export function tierFor(modelId: string, envTier = process.env.AGENT_IMAGE_TIER): ImageTier {
  if (envTier === 'high') return TIER_HIGH;
  if (envTier === 'standard') return TIER_STANDARD;
  const m = /^claude-[a-z]+-(\d+)-(\d+)/.exec(modelId);
  if (!m) return TIER_STANDARD;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 4 || (major === 4 && minor >= 7) ? TIER_HIGH : TIER_STANDARD;
}

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicClient implements ModelClient {
  readonly id: string;
  private readonly key: string;
  private readonly model: string;
  private readonly tier: ImageTier;
  private readonly fetchFn: FetchFn;

  constructor(opts: { model: string; secretsDir?: string; fetchFn?: FetchFn }) {
    this.model = opts.model;
    this.id = `anthropic/${opts.model}`;
    const dir = opts.secretsDir ?? process.env.SECRETS_DIR ?? '/run/secrets';
    this.key = fs.readFileSync(path.join(dir, 'ANTHROPIC_API_KEY'), 'utf8').trim();
    this.tier = tierFor(opts.model);
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  imageSize(screen: Size): Size {
    return resizedSize(screen.width, screen.height, this.tier.maxEdge, this.tier.maxTokens);
  }

  async next(input: { spec: TestSpec; observation: Observation; history: StepRecord[]; schema: object }): Promise<ModelReply> {
    const { observation } = input;
    const userContent: unknown[] = [];
    if (observation.screenshot) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: observation.screenshot.png.toString('base64') },
      });
    }
    userContent.push({ type: 'text', text: buildUserText(input) });
    const body = {
      model: this.model,
      max_tokens: 4096,
      system: systemPromptFor(observation),
      messages: [{ role: 'user', content: userContent }],
      output_config: { format: { type: 'json_schema', schema: input.schema } },
    };
    const data = await postJson<AnthropicResponse>(
      this.fetchFn,
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': this.key, 'anthropic-version': '2023-06-01' },
      body,
    );
    if (data.stop_reason === 'refusal') {
      const refusal = data.content
        ?.map((c) => c.text ?? '')
        .join(' ')
        .trim();
      return {
        raw: { action: { kind: 'done', status: 'FAILED', summary: `Model refusal: ${refusal || 'no reason given'}` } },
        usage: { input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 },
      };
    }
    const block = data.content?.find((c) => c.type === 'text');
    if (!block?.text) throw new Error('Anthropic response had no text content block');
    return {
      raw: JSON.parse(block.text),
      usage: { input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 },
    };
  }
}
