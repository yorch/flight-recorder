import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { Point, Size } from './events.ts';
import { clampToScreen } from './geometry.ts';

const execFileAsync = promisify(execFile);

export class Cursor {
  private readonly screen: Size;
  private pos: Point;

  constructor(screen: Size) {
    this.screen = screen;
    this.pos = { x: Math.floor(screen.width / 2), y: Math.floor(screen.height / 2) }; // Xvfb starts the pointer centered
  }

  async glideTo(target: Point, durationMs = 250, steps = 12): Promise<void> {
    const to = clampToScreen(target, this.screen);
    const from = this.pos;
    for (let i = 1; i <= steps; i++) {
      const k = 0.5 - Math.cos((Math.PI * i) / steps) / 2;
      const x = Math.round(from.x + (to.x - from.x) * k);
      const y = Math.round(from.y + (to.y - from.y) * k);
      await execFileAsync('xdotool', ['mousemove', String(x), String(y)]);
      await sleep(durationMs / steps);
    }
    this.pos = to;
  }
}
