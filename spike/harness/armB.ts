import { chromium } from 'playwright-core';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import type { Adapter } from './adapter.ts';
import { nowMs } from './util.ts';

const RESULTS = process.env.RESULTS_DIR || '/results';
const WS_URL = process.env.WS_URL || 'ws://browser:3000/';

export class ArmB implements Adapter {
  readonly arm = 'b';
  private page: Page | null = null;
  private framesStream: ReturnType<typeof createWriteStream> | null = null;
  private frameIndex = 0;
  private dumpFrames = false;
  private firstFrameResolve: ((recvMs: number) => void) | null = null;

  async connect(extraArgs: string[]): Promise<{ page: Page; context: BrowserContext }> {
    const launchOptions: Record<string, unknown> = {};
    if (extraArgs.length > 0) launchOptions.args = extraArgs;
    if (process.env.CHROMIUM_SANDBOX_ON === '1') launchOptions.chromiumSandbox = true;
    if (process.env.CHROMIUM_SANDBOX_OFF === '1') launchOptions.chromiumSandbox = false;
    const headers: Record<string, string> = {};
    if (Object.keys(launchOptions).length > 0) {
      headers['x-playwright-launch-options'] = JSON.stringify(launchOptions);
    }
    const browser = await chromium.connect(WS_URL, { headers });
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    this.page = page;
    return { page, context };
  }

  async osClick(_x: number, _y: number): Promise<void> {
    throw new Error('osClick not supported on arm b');
  }

  startRecording(): Promise<number | null> {
    fs.mkdirSync(path.join(RESULTS, 'frames'), { recursive: true });
    this.framesStream = createWriteStream(path.join(RESULTS, 'frames.jsonl'));
    const firstFrame = new Promise<number>((resolve) => { this.firstFrameResolve = resolve; });
    void this.page!.screencast.start({
      path: path.join(RESULTS, 'video.webm'),
      fps: 30,
      size: { width: 1920, height: 1080 },
      quality: 90,
      onFrame: ({ data, timestamp, viewportWidth, viewportHeight }) => {
        const recv = nowMs();
        const i = this.frameIndex++;
        this.framesStream!.write(JSON.stringify({ i, timestamp, recv_ms: recv, viewportWidth, viewportHeight, bytes: data.length }) + '\n');
        if (this.dumpFrames) {
          fs.writeFileSync(path.join(RESULTS, 'frames', `${i}_${timestamp}.jpg`), data);
        }
        if (this.firstFrameResolve) {
          this.firstFrameResolve(recv);
          this.firstFrameResolve = null;
        }
      },
    });
    void this.page!.screencast.showActions();
    return firstFrame.then(() => null);
  }

  async stopRecording(): Promise<void> {
    await this.page!.screencast.stop();
    await new Promise<void>((resolve) => this.framesStream!.end(resolve));
  }

  onSegmentStart(name: string): void {
    if (name === 'sync_cdp') this.dumpFrames = true;
  }

  onSegmentEnd(name: string): void {
    if (name === 'sync_cdp') this.dumpFrames = false;
  }
}
