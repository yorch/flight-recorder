import type { TestSpec } from '../config.ts';
import type { Size, Status } from '../events.ts';

export interface Observation {
  step_id: string;
  url: string;
  title: string;
  screenshot?: { png: Buffer } & Size;
  aria_snapshot?: string;
  dialog?: { type: 'alert' | 'confirm' | 'prompt'; message: string; default_value: string };
}

export interface StepRecord {
  step_id: string;
  action?: import('./actions.ts').AgentAction;
  result: Status;
  error?: string;
}

export interface ModelReply {
  raw: unknown;
  usage: { input_tokens: number; output_tokens: number };
}

/** One structured-output call: a system prompt, ordered content parts, and a JSON schema. */
export interface StructuredInput {
  system: string;
  parts: ({ type: 'text'; text: string } | { type: 'image'; png: Buffer })[];
  schema: object;
  name: string; // strict schema name (used by OpenAI)
}

export interface NextInput {
  spec: TestSpec;
  observation: Observation;
  history: StepRecord[];
  schema: object;
  plan?: import('./plan.ts').Plan;
  planStatus?: Record<string, string>;
}

export interface ModelClient {
  readonly id: string;
  imageSize(screen: Size): Size;
  structured(input: StructuredInput): Promise<ModelReply>;
  next(input: NextInput): Promise<ModelReply>;
}
