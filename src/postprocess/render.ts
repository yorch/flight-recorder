import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TimelineEvent } from '../events.ts';
import { buildChapters, runStatusForChapters, toVtt } from './chapters.ts';
import { chooseDuration } from './duration.ts';
import { PARAMS } from './params.ts';
import { buildTimeMap, outputDuration, setptsExpr } from './timemap.ts';
import { buildZoomWindows, zoomExprs } from './zoom.ts';

const execFileAsync = promisify(execFile);

async function ffprobe(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('ffprobe', args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Raw duration: format=duration, falling back to last packet pts_time (§7.4). */
export async function rawDuration(file: string): Promise<number> {
  const fmt = await ffprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).catch(() => 'N/A');
  const packets = await ffprobe([
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'packet=pts_time',
    '-of',
    'csv=p=0',
    file,
  ]).catch(() => '');
  return chooseDuration(fmt, packets);
}

/**
 * Post-processes a run directory (§7): timemap.json, filter.txt,
 * final.mp4, chapters.json, chapters.vtt. Tolerates truncated event logs.
 */
export async function runPostprocess(runDir: string): Promise<void> {
  const rawFile = path.join(runDir, 'raw.mkv');
  const events: TimelineEvent[] = fs
    .readFileSync(path.join(runDir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TimelineEvent);

  const runStart = events.find((e) => e.type === 'RUN_START') as Extract<TimelineEvent, { type: 'RUN_START' }> | undefined;
  const runEnd = events.find((e) => e.type === 'RUN_END') as Extract<TimelineEvent, { type: 'RUN_END' }> | undefined;
  const recStart = events.find((e) => e.type === 'RECORDING_START') as Extract<TimelineEvent, { type: 'RECORDING_START' }> | undefined;
  const videoStartMs = recStart?.video_start_ms ?? events[0]?.t_ms ?? 0;
  const rel = (ms: number) => (ms - videoStartMs) / 1000;
  const screen = runStart?.screen ?? { width: 1920, height: 1080 };

  const duration = await rawDuration(rawFile);

  const segments = buildTimeMap(events, rel, duration);
  fs.writeFileSync(
    path.join(runDir, 'timemap.json'),
    `${JSON.stringify({ duration_raw_s: duration, duration_out_s: outputDuration(segments), segments }, null, 1)}\n`,
  );

  const wins = buildZoomWindows(events, segments, rel, screen);
  const { z, x, y } = zoomExprs(wins, screen.width, screen.height);
  const filter = `[0:v]setpts=PTS-STARTPTS,setpts='(${setptsExpr(segments)})/TB',fps=${PARAMS.FPS},zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${screen.width}x${screen.height}:fps=${PARAMS.FPS},format=yuv420p[out]`;
  const filterFile = path.join(runDir, 'filter.txt');
  fs.writeFileSync(filterFile, filter);

  fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
  const renderLog = fs.createWriteStream(path.join(runDir, 'logs', 'ffmpeg-render.log'), { flags: 'a' });
  try {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-i',
        rawFile,
        '-/filter_complex',
        filterFile,
        '-map',
        '[out]',
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        '23',
        '-movflags',
        '+faststart',
        path.join(runDir, 'final.mp4'),
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    renderLog.write(String(stderr));
  } catch (err) {
    renderLog.write(err instanceof Error && 'stderr' in err ? String((err as { stderr: string }).stderr) : String(err));
    throw err;
  } finally {
    renderLog.end();
  }

  const chapters = buildChapters(events, segments, rel);
  const chaptersJson = {
    run_id: runStart?.run_id ?? path.basename(runDir),
    test: runStart?.test ?? 'unknown',
    status: runStatusForChapters(runEnd),
    summary: runEnd?.summary ?? '',
    duration: outputDuration(segments),
    video: 'final.mp4',
    chapters,
  };
  fs.writeFileSync(path.join(runDir, 'chapters.json'), `${JSON.stringify(chaptersJson, null, 2)}\n`);
  fs.writeFileSync(path.join(runDir, 'chapters.vtt'), toVtt(chapters));
}
