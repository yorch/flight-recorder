import type { Box, Size, TimelineEvent } from '../events.ts';
import { PARAMS } from './params.ts';
import { mapTime, type Segment } from './timemap.ts';

export interface ZoomWindow {
  start: number; // output seconds
  end: number;
  box: Box;
}

const unionBox = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};

/**
 * Zoom windows in output time (§7.3). Each action with an ACTION_TARGET zooms from
 * mapTime(target) − ZOOM_RAMP to mapTime(ACTION_END + ZOOM_HOLD); coordinate-mode
 * actions use DEFAULT_TARGET centered on the point. Windows closer than
 * ZOOM_MERGE_GAP merge with the union box.
 */
export function buildZoomWindows(
  events: TimelineEvent[],
  segments: Segment[],
  rel: (ms: number) => number,
  _screen: Size,
  p = PARAMS,
): ZoomWindow[] {
  const target = new Map<string, { point: { x: number; y: number }; box?: Box; t: number }>();
  const ends = new Map<string, number>();
  for (const ev of events) {
    if (ev.type === 'ACTION_TARGET') target.set(ev.step_id, { point: ev.point, box: ev.box, t: ev.t_ms });
    if (ev.type === 'ACTION_END') ends.set(ev.step_id, ev.t_ms);
  }
  const wins: ZoomWindow[] = [];
  for (const [stepId, t] of target) {
    const endMs = ends.get(stepId);
    if (endMs === undefined) continue;
    const box = t.box ?? {
      x: t.point.x - p.DEFAULT_TARGET.width / 2,
      y: t.point.y - p.DEFAULT_TARGET.height / 2,
      width: p.DEFAULT_TARGET.width,
      height: p.DEFAULT_TARGET.height,
    };
    const start = Math.max(0, mapTime(segments, rel(t.t)) - p.ZOOM_RAMP);
    const end = mapTime(segments, rel(endMs) + p.ZOOM_HOLD);
    if (end <= start) continue;
    wins.push({ start, end, box });
  }
  wins.sort((a, b) => a.start - b.start);
  const merged: ZoomWindow[] = [];
  for (const w of wins) {
    const last = merged.at(-1);
    if (last && w.start - last.end <= p.ZOOM_MERGE_GAP) {
      last.end = Math.max(last.end, w.end);
      last.box = unionBox(last.box, w.box);
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

export function zoomExprs(wins: ZoomWindow[], W: number, H: number, p = PARAMS): { z: string; x: string; y: string } {
  if (!wins.length) return { z: '1', x: '0', y: '0' };
  const f = (n: number) => n.toFixed(3);
  const level = (b: Box) => Math.min(p.ZOOM_MAX, Math.max(1, Math.min(W / (b.width * p.ZOOM_CONTEXT), H / (b.height * p.ZOOM_CONTEXT))));
  const weight = (w: ZoomWindow) => `clip((it-${f(w.start)})/${p.ZOOM_RAMP},0,1)*clip((${f(w.end)}-it)/${p.ZOOM_RAMP},0,1)`;
  const inside = (w: ZoomWindow) => `between(it,${f(w.start)},${f(w.end)})`;
  const center = (axis: (b: Box) => number, mid: number) =>
    `(${wins.map((w) => `${f(axis(w.box))}*${inside(w)}`).join('+')}+${mid}*(1-(${wins.map(inside).join('+')})))`;
  const cx = center((b) => b.x + b.width / 2, W / 2);
  const cy = center((b) => b.y + b.height / 2, H / 2);
  return {
    z: `1+${wins.map((w) => `${f(level(w.box) - 1)}*${weight(w)}`).join('+')}`,
    x: `clip(${cx}-iw/zoom/2,0,iw-iw/zoom)`,
    y: `clip(${cy}-ih/zoom/2,0,ih-ih/zoom)`,
  };
}
