import { type KeyboardEvent, useEffect, useRef } from 'react';
import { baseName, type Shot, stepIndex } from '../lib/gallery.ts';

interface Props {
  shots: Shot[];
  /** Open at this index; null keeps the dialog closed. */
  index: number | null;
  onIndex: (i: number | null) => void;
  label?: string;
}

/**
 * Modal screenshot viewer: previous/next buttons, Left/Right arrow keys, Esc to
 * close, an "i / n" readout and a filmstrip rail. Focus returns to the opener.
 */
export function Lightbox({ shots, index, onIndex, label = 'Screenshot preview' }: Props) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const rail = useRef<HTMLUListElement | null>(null);
  const isOpen = index !== null && shots.length > 0;
  const i = isOpen ? Math.min(index, shots.length - 1) : 0;
  const shot = shots[i];

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (isOpen && !d.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      d.showModal();
    } else if (!isOpen && d.open) {
      d.close();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const active = rail.current?.querySelector<HTMLElement>(`[data-index="${i}"]`);
    active?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [isOpen, i]);

  const close = () => {
    dialog.current?.close();
    onIndex(null);
    opener.current?.focus();
  };
  const go = (delta: number) => onIndex(stepIndex(i, delta, shots.length));

  const onKey = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'Home') onIndex(0);
    else if (e.key === 'End') onIndex(shots.length - 1);
    else if (e.key === 'Escape') close();
    else return;
    e.preventDefault();
  };

  return (
    <dialog
      ref={dialog}
      className="lightbox"
      aria-label={label}
      onKeyDown={onKey}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      {isOpen && shot && (
        <>
          <div className="lightbox-bar">
            <div className="lightbox-caption">
              <strong className="lightbox-index" aria-live="polite" data-testid="lightbox-index">
                {i + 1} / {shots.length}
              </strong>
              <span className="mono small">{baseName(shot.ref)}</span>
              {shot.group && <span className="muted small">{shot.group}</span>}
            </div>
            <div className="row">
              <a className="btn small" href={shot.src} target="_blank" rel="noreferrer">
                Open original
              </a>
              <button type="button" className="btn" onClick={close}>
                Close preview
              </button>
            </div>
          </div>
          <div className="lightbox-stage">
            <button
              type="button"
              className="lightbox-nav prev"
              aria-label="Previous screenshot"
              disabled={shots.length < 2}
              onClick={() => go(-1)}
            />
            <img src={shot.src} alt={`Screenshot ${i + 1} of ${shots.length}: ${baseName(shot.ref)}`} />
            <button
              type="button"
              className="lightbox-nav next"
              aria-label="Next screenshot"
              disabled={shots.length < 2}
              onClick={() => go(1)}
            />
          </div>
          {shots.length > 1 && (
            <ul className="filmstrip" ref={rail} aria-label="All screenshots">
              {shots.map((s, j) => (
                <li key={s.src}>
                  <button
                    type="button"
                    className="filmstrip-item"
                    data-index={j}
                    aria-current={j === i ? 'true' : undefined}
                    aria-label={`Show screenshot ${j + 1}`}
                    onClick={() => onIndex(j)}
                  >
                    <img src={s.src} alt="" loading="lazy" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small lightbox-hint">Use the Left and Right arrow keys to browse. Press Esc to close.</p>
        </>
      )}
    </dialog>
  );
}
