import { useRef, useState } from 'react';
import type { ChaptersFile } from '../lib/api.ts';
import { artifactUrl } from '../lib/api.ts';
import { toneOf } from '../lib/status.ts';
import { Panel } from './Panel.tsx';
import { StatusBadge } from './StatusBadge.tsx';

/** §8: chapters are contiguous; the active one is the last that has started. */
export function activeChapter(chapters: ChaptersFile['chapters'], t: number) {
  let active: ChaptersFile['chapters'][number] | null = null;
  for (const c of chapters) if (t >= c.start) active = c;
  return active;
}

const pct = (v: number, total: number) => `${total > 0 ? Math.min(100, Math.max(0, (v / total) * 100)) : 0}%`;

/** §16.3: final.mp4 player, a proportional chapter bar with a playhead, and a chapter list that seeks the player. */
export function VideoPanel({ runId, data }: { runId: string; data: ChaptersFile | null }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const [time, setTime] = useState(0);
  if (!data || data.chapters.length === 0) return null;

  const seek = (t: number) => {
    if (video.current) {
      video.current.currentTime = t;
      setTime(t);
      // jsdom's play() returns undefined; browsers return a promise that may reject.
      const p = video.current.play() as Promise<void> | undefined;
      void p?.catch(() => {});
    }
  };
  const active = activeChapter(data.chapters, time);
  const failed = data.chapters.filter((c) => toneOf(c.status) === 'bad').length;

  return (
    <Panel
      title="Recording"
      testId="video-panel"
      className="recording"
      meta={`${data.chapters.length} chapters${failed ? ` · ${failed} failed` : ''} · ${data.duration.toFixed(1)}s`}
    >
      <div className="video-layout">
        <div className="video-col">
          {/* biome-ignore lint/a11y/useMediaCaption: screen-capture video has no audio; chapters.vtt is a chapters track, not captions */}
          <video
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            ref={video}
            controls
            preload="auto"
            src={artifactUrl(runId, data.video || 'final.mp4')}
            data-testid="run-video"
          >
            <track kind="chapters" src={artifactUrl(runId, 'chapters.vtt')} default />
          </video>
          <div className="chapter-bar">
            {data.chapters.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`seg ${active?.id === c.id ? 'active' : ''}`}
                data-tone={toneOf(c.status)}
                style={{ left: pct(c.start, data.duration), width: pct(c.end - c.start, data.duration) }}
                aria-label={`Seek to ${c.title} at ${c.start.toFixed(1)}s`}
                title={`${c.start.toFixed(1)}s ${c.title}`}
                tabIndex={-1}
                onClick={() => seek(c.start)}
              />
            ))}
            <span className="playhead" style={{ left: pct(time, data.duration) }} aria-hidden="true" />
          </div>
          <p className="file-links mono">
            <a href={artifactUrl(runId, 'raw.mkv')}>raw.mkv</a>
            <a href={artifactUrl(runId, 'chapters.vtt')}>chapters.vtt</a>
            <span>t = {time.toFixed(1)}s</span>
          </p>
        </div>
        <ol className="chapters" data-testid="chapter-list">
          {data.chapters.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={`chapter ${active?.id === c.id ? 'active' : ''}`}
                aria-current={active?.id === c.id ? 'step' : undefined}
                data-start={c.start}
                data-tone={toneOf(c.status)}
                onClick={() => seek(c.start)}
              >
                <span className="mono chapter-t">{c.start.toFixed(1)}s</span>
                <span className="chapter-title">{c.title}</span>
                <StatusBadge status={c.status} />
              </button>
            </li>
          ))}
        </ol>
      </div>
    </Panel>
  );
}
