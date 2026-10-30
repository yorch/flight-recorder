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

export interface ModelClient {
  readonly id: string;
  imageSize(screen: Size): Size;
  next(input: { spec: TestSpec; observation: Observation; history: StepRecord[]; schema: object }): Promise<ModelReply>;
}
