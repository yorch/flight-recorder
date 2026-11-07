import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactsPanel } from './ArtifactsPanel.tsx';

describe('ArtifactsPanel', () => {
  afterEach(cleanup);

  it('shows an empty state and the in-progress hint when nothing exists yet', () => {
    const view = render(<ArtifactsPanel runId="r1" files={[]} terminal={false} />);
    expect(view.queryByRole('table')).toBeNull();
    expect(view.getByText(/No artifacts yet/)).toBeTruthy();
    expect(view.getByText(/Run in progress/)).toBeTruthy();
  });

  it('lists only files that exist, known ones with descriptions and sizes', () => {
    const view = render(
      <ArtifactsPanel
        runId="r1"
        files={[
          { file: 'run.json', bytes: 512 },
          { file: 'final.mp4', bytes: 3 * 1024 * 1024 },
          { file: 'status.json', bytes: 40 },
        ]}
        terminal
      />,
    );
    const links = view.getAllByRole('link').map((a) => a.textContent);
    expect(links).toEqual(['final.mp4', 'run.json', 'status.json']);
    expect(view.queryByText('report.html')).toBeNull();
    expect(view.getByText('3.0 MB')).toBeTruthy();
    expect(view.getByText('512 B')).toBeTruthy();
    expect(view.queryByText(/Run in progress/)).toBeNull();
    expect(view.getByRole('link', { name: 'final.mp4' }).getAttribute('href')).toBe('/artifacts/r1/final.mp4');
  });
});
