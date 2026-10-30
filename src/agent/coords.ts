import type { Point, Size } from '../events.ts';
import { clampToScreen } from '../geometry.ts';

/** Maps a model-space screenshot point to screen pixels, clamped to the screen (§6.2). */
export function imageToScreen(point: Point, imageSize: Size, screen: Size): Point {
  return clampToScreen(
    {
      x: Math.round((point.x * screen.width) / imageSize.width),
      y: Math.round((point.y * screen.height) / imageSize.height),
    },
    screen,
  );
}
