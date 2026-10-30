import { chromium } from 'playwright-core';
import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import type { Adapter } from './adapter.ts';

const RESULTS = process.env.RESULTS_DIR || '/results';
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const DISPLAY = process.env.DISPLAY || ':99';

export class ArmA implements Adapter {
  readonly arm = 'a';
  private ffmpeg: ReturnType<typeof spawn> | null = null;
  private ffmpegExit: Promise<number | null> | null = null;

  async connect(_extraArgs: string[]): Promise<{ page: Page; context: BrowserContext }> {
    const browser = await chromium.connectOverCDP(CDP_URL);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.newPage());
    return { page, context };
  }

  async osClick(x: number, y: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      execFile('xdotool', ['mousemove', String(x), String(y), 'click', '1'], (err) => (err ? reject(err) : resolve()));
    });
  }

  startRecording(): Promise<number | null> {
    fs.mkdirSync(path.join(RESULTS, 'logs'), { recursive: true });
    const stderrLog = createWriteStream(path.join(RESULTS, 'logs', 'ffmpeg.log'));
    const args = [
      '-hide_banner', '-nostats', '-loglevel', 'info',
      '-f', 'x11grab', '-framerate', '30', '-video_size', '1920x1080', '-draw_mouse', '1',
      '-i', `${DISPLAY}.0`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-g', '30', '-pix_fmt', 'yuv420p',
      path.join(RESULTS, 'video.mkv'),
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.ffmpeg = proc;
    proc.stderr!.pipe(stderrLog);
    this.ffmpegExit = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));

    return new Promise<number | null>((resolve, reject) => {
      let buf = '';
      let done = false;
      const timer = setTimeout(() => {
        if (!done) { done = true; reject(new Error('timed out waiting for ffmpeg x11grab start timestamp')); }
      }, 15000);
      proc.stderr!.on('data', (chunk: Buffer) => {
        if (done) return;
        buf += chunk.toString();
        const m = buf.match(/Input #0, x11grab[\s\S]*?start: (\d+\.\d+)/);
        if (m) {
          done = true;
          clearTimeout(timer);
          resolve(parseFloat(m[1]) * 1000);
        }
      });
      proc.on('exit', () => {
        if (!done) { done = true; clearTimeout(timer); reject(new Error('ffmpeg exited before producing a start timestamp')); }
      });
    });
  }

  async stopRecording(): Promise<void> {
    if (!this.ffmpeg || !this.ffmpegExit) return;
    this.ffmpeg.stdin!.write('q');
    const code = await this.ffmpegExit;
    if (code !== 0 && code !== 255) throw new Error(`ffmpeg exited with code ${code}`);
  }

  onSegmentStart(_name: string): void {}
  onSegmentEnd(_name: string): void {}
}
