import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Gallery, groupScreenshots } from './Gallery.tsx';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });
});
afterEach(cleanup);

const names = ['s1.png', 's2.png', 's3.png'];
const stage = (dialog: HTMLElement) => dialog.querySelector('.lightbox-stage img')?.getAttribute('src');

describe('Screenshot evidence', () => {
  it('opens a modal preview and returns focus to the thumbnail on close', () => {
    const view = render(<Gallery runId="test" report={null} names={['step.png']} />);
    const thumb = view.container.querySelector('.thumb') as HTMLButtonElement;
    fireEvent.click(thumb);
    const dialog = view.getByRole('dialog');
    expect(stage(dialog)).toBe('/artifacts/test/screenshots/step.png');
    expect(view.getByTestId('lightbox-index').textContent).toBe('1 / 1');
    fireEvent.click(view.getByText('Close preview'));
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(thumb);
  });

  it('navigates with buttons (wrapping), arrow keys, Home/End and the filmstrip; Esc closes', () => {
    const view = render(<Gallery runId="r" report={null} names={names} />);
    const thumbs = view.container.querySelectorAll<HTMLButtonElement>('.thumb');
    fireEvent.click(thumbs[1] as HTMLButtonElement);
    const dialog = view.getByRole('dialog');
    const index = () => view.getByTestId('lightbox-index').textContent;
    expect(index()).toBe('2 / 3');
    fireEvent.click(view.getByLabelText('Next screenshot'));
    expect(index()).toBe('3 / 3');
    expect(stage(dialog)).toBe('/artifacts/r/screenshots/s3.png');
    fireEvent.click(view.getByLabelText('Next screenshot'));
    expect(index()).toBe('1 / 3');
    fireEvent.click(view.getByLabelText('Previous screenshot'));
    expect(index()).toBe('3 / 3');
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(index()).toBe('2 / 3');
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(index()).toBe('3 / 3');
    fireEvent.keyDown(dialog, { key: 'Home' });
    expect(index()).toBe('1 / 3');
    fireEvent.keyDown(dialog, { key: 'End' });
    expect(index()).toBe('3 / 3');
    const strip = dialog.querySelectorAll<HTMLButtonElement>('.filmstrip-item');
    expect(strip).toHaveLength(3);
    expect(strip[2]?.getAttribute('aria-current')).toBe('true');
    fireEvent.click(strip[0] as HTMLButtonElement);
    expect(index()).toBe('1 / 3');
    expect(strip[0]?.getAttribute('aria-current')).toBe('true');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(thumbs[1]);
  });

  it('closes on the native cancel event too', () => {
    const view = render(<Gallery runId="r" report={null} names={names} />);
    fireEvent.click(view.container.querySelector('.thumb') as HTMLButtonElement);
    const dialog = view.getByRole('dialog');
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(dialog.hasAttribute('open')).toBe(false);
  });

  it('keeps a flat fallback before report grouping is available', () => {
    expect(groupScreenshots(null, ['first.png'])).toEqual([{ label: 'all', paths: ['screenshots/first.png'] }]);
    expect(groupScreenshots(null, [])).toEqual([]);
  });
});
