import { useRef } from 'react';
import type { ChaptersFile } from '../lib/api.ts';
import { artifactUrl } from '../lib/api.ts';
import { StatusBadge } from './StatusBadge.tsx';

/** §8: chapters are contiguous; the active one is the last that has started. */
export function activeChapter(chapters: ChaptersFile['chapters'], t: number) {
  let active: ChaptersFile['chapters'][number] | null = null;
  for (const c of chapters) if (t >= c.start) active = c;
  return active;
}

/** §16.3: final.mp4 player + clickable chapter list that seeks the player. */
export function VideoPanel({ runId, data }: { runId: string; data: ChaptersFile | null }) {
  const video = useRef<HTMLVideoElement | null>(null);
  if (!data || data.chapters.length === 0) return null;

  const seek = (t: number) => {
    if (video.current) {
      video.current.currentTime = t;
      // jsdom's play() returns undefined; browsers return a promise that may reject.
      const p = video.current.play() as Promise<void> | undefined;
      void p?.catch(() => {});
    }
  };

  return (
    <section className="panel" data-testid="video-panel">
      <h3>Video</h3>
      {/* biome-ignore lint/a11y/useMediaCaption: screen-capture video has no audio; chapters.vtt is a chapters track, not captions */}
      <video ref={video} controls preload="auto" src={artifactUrl(runId, data.video || 'final.mp4')} data-testid="run-video">
        <track kind="chapters" src={artifactUrl(runId, 'chapters.vtt')} default />
      </video>
      <ol className="chapters" data-testid="chapter-list">
        {data.chapters.map((c) => (
          <li key={c.id}>
            <button type="button" className="chapter" data-start={c.start} onClick={() => seek(c.start)}>
              <span className="mono">{c.start.toFixed(1)}s</span> {c.title} <StatusBadge status={c.status} />
            </button>
          </li>
        ))}
      </ol>
      <p className="muted small">
        <a href={artifactUrl(runId, 'raw.mkv')}>raw.mkv</a> · <a href={artifactUrl(runId, 'chapters.vtt')}>chapters.vtt</a> · duration{' '}
        {data.duration.toFixed(1)}s
      </p>
    </section>
  );
}
