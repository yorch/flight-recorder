import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ChaptersFile } from '../lib/api.ts';
import { activeChapter, VideoPanel } from './VideoPanel.tsx';

const data: ChaptersFile = {
  run_id: '20261030-120000-aaaa',
  test: 'blog',
  status: 'PASSED',
  duration: 12.4,
  video: 'final.mp4',
  chapters: [
    { id: 's0000', title: 'Open blog', status: 'PASSED', start: 0, end: 0.5, plan_step: null },
    { id: 's0001', title: 'p1 · Enter email', status: 'PASSED', start: 0.5, end: 2.0, plan_step: 'p1' },
    { id: 's0002', title: 'p1 · Click Sign in', status: 'FAILED', start: 2.0, end: 12.4, plan_step: 'p1' },
  ],
};

describe('VideoPanel chapter-seek wiring', () => {
  it('renders one row per chapter and seeks the player on click', () => {
    const { container } = render(<VideoPanel runId={data.run_id} data={data} />);
    expect(container.querySelectorAll('.chapter').length).toBe(3);
    const video = container.querySelector('video') as HTMLVideoElement;
    const target = container.querySelectorAll('.chapter')[2] as HTMLButtonElement;
    fireEvent.click(target);
    expect(video.currentTime).toBeCloseTo(2.0, 5);
    const first = container.querySelectorAll('.chapter')[0] as HTMLButtonElement;
    fireEvent.click(first);
    expect(video.currentTime).toBe(0);
  });

  it('points video at the run artifact URL and ships a chapters track', () => {
    const { container } = render(<VideoPanel runId={data.run_id} data={data} />);
    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video.getAttribute('src')).toBe(`/artifacts/${data.run_id}/final.mp4`);
    expect(container.querySelector('track')?.getAttribute('src')).toBe(`/artifacts/${data.run_id}/chapters.vtt`);
  });
});

describe('activeChapter', () => {
  it('is the last chapter that has started (contiguous chapters, §8)', () => {
    expect(activeChapter(data.chapters, 0)?.id).toBe('s0000');
    expect(activeChapter(data.chapters, 1.0)?.id).toBe('s0001');
    expect(activeChapter(data.chapters, 99)?.id).toBe('s0002');
  });
});
