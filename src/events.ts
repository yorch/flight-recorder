import { createWriteStream, type WriteStream } from 'node:fs';
import { performance } from 'node:perf_hooks';

export type Status = 'PASSED' | 'FAILED';
export type RunStatus = Status | 'UNVERIFIED' | 'CANCELLED';
export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };
export type ActionKind = 'navigate' | 'click' | 'type' | 'press' | 'scroll' | 'dialog' | 'assert' | 'step' | 'upload';
export type ActionMode = 'ELEMENT' | 'COORDINATE' | 'PAGE' | 'AGENT';

export type TimelineEvent = { seq: number; t_ms: number } & (
  | { type: 'RUN_START'; run_id: string; test: string; screen: Size; chrome_version: string; model: string }
  | { type: 'RECORDING_START'; file: string; video_start_ms: number }
  | { type: 'THINKING_START'; step_id: string }
  | { type: 'THINKING_END'; step_id: string }
  | { type: 'ACTION_START'; step_id: string; label: string; action: ActionKind; mode: ActionMode; plan_step?: string | null }
  | { type: 'ACTION_TARGET'; step_id: string; point: Point; box?: Box }
  | { type: 'ACTION_END'; step_id: string; status: Status; error?: string; notes?: string }
  | { type: 'RECORDING_STOP' }
  | { type: 'RUN_END'; status: RunStatus; summary: string }
);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventInput = DistributiveOmit<TimelineEvent, 'seq' | 't_ms'>;

export const nowMs = (): number => performance.timeOrigin + performance.now();

export class EventLog {
  private seq = 0;
  private readonly stream: WriteStream;
  readonly events: TimelineEvent[] = []; // in-memory copy (events.jsonl needs closing to be readable)

  constructor(path: string) {
    this.stream = createWriteStream(path, { flags: 'wx' });
  }

  emit(input: EventInput): void {
    const ev = { seq: this.seq++, t_ms: nowMs(), ...input } as TimelineEvent;
    this.events.push(ev);
    this.stream.write(`${JSON.stringify(ev)}\n`);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}
