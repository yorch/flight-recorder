import fs from 'node:fs';
import path from 'node:path';
import type { TestSpec } from '../../config.ts';
import type { Size } from '../../events.ts';
import type { ModelClient, ModelReply, Observation, StepRecord } from '../contract.ts';
import { buildUserText, systemPromptFor } from '../prompt.ts';
import { postJson } from './http.ts';

type FetchFn = typeof fetch;

const MAX_DIM = 6000;
const MAX_PATCHES = 10_000;
const PATCH = 32;

const countPatches = (w: number, h: number) => Math.ceil(w / PATCH) * Math.ceil(h / PATCH);

/** Conservative limits for detail:'original' (decision 3): 6000px max dim, 10k 32px patches. */
export function imageSizeOpenAI(width: number, height: number): Size {
  if (width <= MAX_DIM && height <= MAX_DIM && countPatches(width, height) <= MAX_PATCHES) {
    return { width, height };
  }
  let w = width;
  let h = height;
  const edgeScale = Math.min(1, MAX_DIM / Math.max(w, h));
  w = Math.floor(w * edgeScale);
  h = Math.floor(h * edgeScale);
  if (countPatches(w, h) > MAX_PATCHES) {
    const s = Math.sqrt((PATCH * PATCH * MAX_PATCHES) / (w * h));
    w = Math.floor(w * s);
    h = Math.floor(h * s);
    while (countPatches(w, h) > MAX_PATCHES && (w > 1 || h > 1)) {
      if (w >= h) w -= 1;
      else h -= 1;
    }
  }
  return { width: Math.max(1, w), height: Math.max(1, h) };
}

interface OpenAIResponse {
  output?: { type?: string; content?: { type: string; text?: string; refusal?: string }[] }[];
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class OpenAIClient implements ModelClient {
  readonly id: string;
  private readonly key: string;
  private readonly model: string;
  private readonly fetchFn: FetchFn;

  constructor(opts: { model: string; secretsDir?: string; fetchFn?: FetchFn }) {
    this.model = opts.model;
    this.id = `openai/${opts.model}`;
    const dir = opts.secretsDir ?? process.env.SECRETS_DIR ?? '/run/secrets';
    this.key = fs.readFileSync(path.join(dir, 'OPENAI_API_KEY'), 'utf8').trim();
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  imageSize(screen: Size): Size {
    return imageSizeOpenAI(screen.width, screen.height);
  }

  async next(input: { spec: TestSpec; observation: Observation; history: StepRecord[]; schema: object }): Promise<ModelReply> {
    const { observation } = input;
    const content: unknown[] = [];
    if (observation.screenshot) {
      content.push({
        type: 'input_image',
        image_url: `data:image/png;base64,${observation.screenshot.png.toString('base64')}`,
        detail: 'original',
      });
    }
    content.push({ type: 'input_text', text: buildUserText(input) });
    const body = {
      model: this.model,
      instructions: systemPromptFor(observation),
      input: [{ role: 'user', content }],
      text: { format: { type: 'json_schema', name: 'agent_turn', schema: input.schema, strict: true } },
    };
    const data = await postJson<OpenAIResponse>(
      this.fetchFn,
      'https://api.openai.com/v1/responses',
      { Authorization: `Bearer ${this.key}` },
      body,
    );
    let answer: string | undefined;
    for (const item of data.output ?? []) {
      for (const c of item.content ?? []) {
        if (c.type === 'output_text' && c.text) answer ??= c.text;
        if (c.type === 'refusal') {
          answer ??= JSON.stringify({ action: { kind: 'done', status: 'FAILED', summary: `Model refusal: ${c.refusal ?? ''}` } });
        }
      }
    }
    answer ??= data.output_text;
    if (!answer) throw new Error('OpenAI response had no output text');
    return {
      raw: JSON.parse(answer),
      usage: { input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 },
    };
  }
}
