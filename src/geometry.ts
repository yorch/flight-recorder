import type { Point, Size } from './events.ts';

/** Rounds and clamps a point to the screen; rejects non-finite values. */
export function clampToScreen(p: Point, screen: Size): Point {
  const x = Math.round(Number(p.x));
  const y = Math.round(Number(p.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Invalid point: ${JSON.stringify(p)}`);
  return { x: Math.min(Math.max(x, 0), screen.width - 1), y: Math.min(Math.max(y, 0), screen.height - 1) };
}
