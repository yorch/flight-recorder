import type { TimelineEvent } from '../events.ts';
import { PARAMS } from './params.ts';

export interface Segment {
  inStart: number;
  inEnd: number;
  outStart: number;
  speed: number;
} // seconds
export type Span = [number, number];

const ms = (t: number) => Math.round(t * 1000) / 1000; // boundaries are rounded once, so setpts terms stay contiguous

export function subtract(spans: Span[], cuts: Span[]): Span[] {
  return cuts.reduce<Span[]>(
    (acc, [cs, ce]) =>
      acc.flatMap(([s, e]): Span[] =>
        ce <= s || cs >= e
          ? [[s, e]]
          : (
              [
                [s, Math.max(s, cs)],
                [Math.min(e, ce), e],
              ] as Span[]
            ).filter(([a, b]) => b > a),
      ),
    spans,
  );
}

export function buildTimeMap(events: TimelineEvent[], rel: (ms: number) => number, duration: number, p = PARAMS): Segment[] {
  const starts = new Map<string, number>();
  const active: Span[] = [];
  const cuts: Span[] = [];
  for (const ev of events) {
    if (ev.type === 'ACTION_START') starts.set(ev.step_id, rel(ev.t_ms));
    const s = ev.type === 'ACTION_END' ? starts.get(ev.step_id) : undefined;
    if (ev.type !== 'ACTION_END' || s === undefined) continue;
    const e = rel(ev.t_ms);
    active.push([s - p.PRE_PAD, e + p.POST_PAD]);
    if (e - s > p.ACTIVE_MAX) cuts.push([s + p.ACTIVE_KEEP, e - p.ACTIVE_KEEP]);
  }

  const merged: Span[] = [];
  for (const [s, e] of active.sort((a, b) => a[0] - b[0])) {
    const a = Math.max(0, s);
    const b = Math.min(duration, e);
    if (b <= a) continue;
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const kept = subtract(merged, cuts);

  const segments: Segment[] = [];
  let out = 0;
  const push = (a0: number, b0: number, speed: number) => {
    const a = ms(a0);
    const b = ms(b0);
    if (b <= a) return;
    segments.push({ inStart: a, inEnd: b, outStart: out, speed });
    out += (b - a) / speed;
  };
  const idle = (a: number, b: number) => push(a, b, b - a < p.MIN_IDLE ? 1 : Math.max(p.IDLE_SPEED, (b - a) / p.IDLE_MAX_OUT));

  let cursor = 0;
  for (const [a, b] of kept) {
    idle(cursor, a);
    push(a, b, 1);
    cursor = b;
  }
  idle(cursor, duration);
  return segments;
}

export function mapTime(segments: Segment[], t: number): number {
  const s = segments.find((seg) => t < seg.inEnd) ?? segments.at(-1);
  if (!s) return 0;
  return s.outStart + (Math.min(Math.max(t, s.inStart), s.inEnd) - s.inStart) / s.speed;
}

export const outputDuration = (segments: Segment[]): number => segments.reduce((acc, s) => acc + (s.inEnd - s.inStart) / s.speed, 0);

/** Piecewise-linear remap as a flat sum, f(T) = Σ clip(T − a_i, 0, len_i) / speed_i, for ffmpeg's setpts. */
export const setptsExpr = (segments: Segment[]): string =>
  segments.map((s) => `${(1 / s.speed).toFixed(6)}*clip(T-${s.inStart.toFixed(3)},0,${(s.inEnd - s.inStart).toFixed(3)})`).join('+');
