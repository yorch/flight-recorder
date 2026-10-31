import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Gallery, groupScreenshots } from './Gallery.tsx';

describe('Screenshot evidence', () => {
  it('opens a modal preview and returns focus to the thumbnail on close', () => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    });
    const view = render(<Gallery runId="test" report={null} names={['step.png']} />);
    const thumb = view.container.querySelector('.thumb') as HTMLButtonElement;
    fireEvent.click(thumb);
    const dialog = view.getByRole('dialog');
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('/artifacts/test/screenshots/step.png');
    fireEvent.click(view.getByText('Close preview'));
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(thumb);
  });
  it('keeps a flat fallback before report grouping is available', () => {
    expect(groupScreenshots(null, ['first.png'])).toEqual([{ label: 'all', paths: ['screenshots/first.png'] }]);
    expect(groupScreenshots(null, [])).toEqual([]);
  });
});
