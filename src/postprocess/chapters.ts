import type { RunStatus, Status, TimelineEvent } from '../events.ts';
import { mapTime, outputDuration, type Segment } from './timemap.ts';

export interface Chapter {
  id: string;
  title: string;
  status: Status;
  start: number;
  end: number;
  plan_step?: string | null;
} // output seconds

/** Run status for chapters.json: a missing RUN_END means the run was truncated or killed. */
export function runStatusForChapters(runEnd: { status: RunStatus } | undefined): RunStatus {
  return runEnd ? runEnd.status : 'FAILED';
}

export function buildChapters(events: TimelineEvent[], segs: Segment[], rel: (ms: number) => number): Chapter[] {
  const chapters: Chapter[] = [];
  let open: number | undefined;
  for (const ev of events) {
    if (ev.type === 'THINKING_START') open ??= rel(ev.t_ms);
    if (ev.type === 'ACTION_START') {
      const title = ev.plan_step ? `${ev.plan_step} · ${ev.label}` : ev.label;
      chapters.push({
        id: ev.step_id,
        title,
        status: 'FAILED',
        start: mapTime(segs, open ?? rel(ev.t_ms)),
        end: 0,
        plan_step: ev.plan_step ?? null,
      });
      open = undefined;
    }
    if (ev.type === 'ACTION_END') {
      const ch = chapters.find((c) => c.id === ev.step_id);
      if (ch) ch.status = ev.status;
    }
  }
  const total = outputDuration(segs);
  chapters.forEach((ch, i) => {
    ch.end = chapters[i + 1]?.start ?? total;
  });
  if (chapters.length) chapters[0].start = 0;
  return chapters;
}

const vttTime = (s: number) => new Date(Math.round(s * 1000)).toISOString().slice(11, 23);

export const toVtt = (chapters: Chapter[]): string =>
  [
    'WEBVTT',
    '',
    ...chapters.flatMap((c) => [c.id, `${vttTime(c.start)} --> ${vttTime(c.end)}`, `${c.title.replaceAll('-->', '->')} (${c.status})`, '']),
  ].join('\n');

export const activeChapter = (chapters: Chapter[], t: number): Chapter | null => chapters.findLast((c) => t >= c.start) ?? null;
