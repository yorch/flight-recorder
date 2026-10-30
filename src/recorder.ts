import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import type { Size } from './events.ts';

type RecorderConfig = Size & { display: string; fps: number };

export class ScreenRecorder {
  private readonly cfg: RecorderConfig;
  private proc: ChildProcess | undefined;

  constructor(cfg: RecorderConfig) {
    this.cfg = cfg;
  }

  /** Starts capture; resolves with the epoch ms of the first captured frame. */
  start(outFile: string, logFile: string): Promise<number> {
    const { display, width, height, fps } = this.cfg;
    const proc = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostats',
        '-loglevel',
        'info',
        '-f',
        'x11grab',
        '-framerate',
        String(fps),
        '-video_size',
        `${width}x${height}`,
        '-draw_mouse',
        '1',
        '-i',
        `${display}.0`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '18',
        '-g',
        String(fps),
        '-pix_fmt',
        'yuv420p',
        '-flush_packets',
        '1',
        outFile,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    this.proc = proc;
    const stderr = proc.stderr;
    if (!stderr) throw new Error('ffmpeg stderr unavailable');
    stderr.pipe(createWriteStream(logFile));

    return new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('ffmpeg reported no start time within 10s')), 10_000);
      const onData = (chunk: Buffer) => {
        buf += chunk.toString();
        const m = /Input #0, x11grab[\s\S]*?start: (\d+\.\d+)/.exec(buf);
        if (!m) return;
        stderr.off('data', onData);
        clearTimeout(timer);
        resolve(parseFloat(m[1] ?? '0') * 1000);
      };
      stderr.on('data', onData);
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`ffmpeg exited early (code ${code})`));
      });
    });
  }

  /** Asks ffmpeg to finish ('q' on stdin) and waits for it to exit; SIGKILL after 10s. */
  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = once(proc, 'exit');
    const killer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
    proc.stdin?.end('q');
    await exited;
    clearTimeout(killer);
  }
}
