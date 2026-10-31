import { useCallback, useEffect, useRef, useState } from 'react';
import {
  apiGet,
  artifactUrl,
  type ChaptersFile,
  type LiveProgress,
  type RunDetail,
  type RunJson,
  type StatusInfo,
  type TimelineEvent,
} from './api.ts';

export interface RunData {
  detail: RunDetail | null;
  error: string | null;
  liveStatus: StatusInfo | null;
  run: RunJson | null;
  phase: string | null;
  terminal: boolean;
  events: TimelineEvent[];
  progress: LiveProgress | null;
  shots: string[];
  chapters: ChaptersFile | null;
  sseState: 'open' | 'closed';
  reload: () => Promise<RunDetail | null>;
}

/**
 * All run-detail IO: the detail API (polled every 4 s), the screenshots list
 * (every 1.5 s while live), the SSE stream (timeline events, `status`, `progress`,
 * `done`) and the terminal artifacts (chapters.json, events.jsonl).
 */
export function useRunDetail(id: string): RunData {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<StatusInfo | null>(null);
  const [liveRun, setLiveRun] = useState<RunJson | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [progress, setProgress] = useState<LiveProgress | null>(null);
  const [shots, setShots] = useState<string[]>([]);
  const [chapters, setChapters] = useState<ChaptersFile | null>(null);
  const [sseState, setSseState] = useState<'open' | 'closed'>('closed');
  const eventsSeen = useRef(new Set<number>());

  const load = useCallback(async () => {
    try {
      const d = await apiGet<RunDetail>(`/api/runs/${id}`);
      setDetail(d);
      if (d.progress) setProgress(d.progress);
      setError(null);
      return d;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [id]);

  const loadShots = useCallback(async () => {
    try {
      const { screenshots } = await apiGet<{ screenshots: string[] }>(`/api/runs/${id}/screenshots`);
      setShots((prev) => (prev.length === screenshots.length && prev.every((s, i) => s === screenshots[i]) ? prev : screenshots));
    } catch {
      /* endpoint or dir absent yet */
    }
  }, [id]);

  const loadTerminalArtifacts = useCallback(async () => {
    try {
      setChapters(await apiGet<ChaptersFile>(artifactUrl(id, 'chapters.json')));
    } catch {
      /* no postprocess output */
    }
    try {
      const text = await (await fetch(artifactUrl(id, 'events.jsonl'))).text();
      const evs = text
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as TimelineEvent);
      for (const e of evs) eventsSeen.current.add(e.seq);
      setEvents(evs);
    } catch {
      /* no events file */
    }
    void loadShots();
    void load();
  }, [id, load, loadShots]);

  const run = liveRun ?? detail?.run ?? null;
  const phase = liveStatus?.phase ?? detail?.status?.phase ?? null;
  const terminal = run !== null;

  // Initial load + detail refresh every 4 s.
  useEffect(() => {
    let cancelled = false;
    void load().then((d) => {
      if (d?.run) void loadTerminalArtifacts();
      else void loadShots();
    });
    const iv = window.setInterval(() => {
      if (cancelled) return;
      void load().then((d) => {
        if (d?.run) void loadTerminalArtifacts();
      });
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [load, loadShots, loadTerminalArtifacts]);

  // Live screenshots every 1.5 s while the run is non-terminal.
  useEffect(() => {
    if (terminal) return;
    const iv = window.setInterval(() => void loadShots(), 1500);
    return () => window.clearInterval(iv);
  }, [terminal, loadShots]);

  // SSE: the server closes with a 'done' event once run.json exists. EventSource
  // reconnects on stream failure using the server's `retry:` interval; we close
  // permanently at terminal state.
  useEffect(() => {
    if (terminal) return;
    const es = new EventSource(`/api/runs/${id}/events`);
    setSseState('open');
    const json = <T>(m: Event, set: (v: T) => void) => {
      try {
        set(JSON.parse((m as MessageEvent).data as string) as T);
      } catch {
        /* partial write */
      }
    };
    es.onmessage = (m) =>
      json<TimelineEvent>(m, (e) => {
        if (eventsSeen.current.has(e.seq)) return;
        eventsSeen.current.add(e.seq);
        setEvents((prev) => [...prev, e]);
      });
    es.addEventListener('status', (m) => json(m, setLiveStatus));
    es.addEventListener('progress', (m) => json(m, setProgress));
    es.addEventListener('done', (m) => {
      json(m, setLiveRun);
      es.close();
      setSseState('closed');
      void loadTerminalArtifacts();
    });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) setSseState('closed');
    };
    return () => {
      es.close();
      setSseState('closed');
    };
  }, [id, terminal, loadTerminalArtifacts]);

  return { detail, error, liveStatus, run, phase, terminal, events, progress, shots, chapters, sseState, reload: load };
}
