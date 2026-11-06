import { useEffect, useRef } from 'react';
import { SHORTCUTS } from '../lib/keys.ts';

export function KeyHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="keyhelp"
      aria-label="Keyboard shortcuts"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header className="panel-head">
        <h2>Keyboard shortcuts</h2>
        <div className="panel-actions">
          <button type="button" className="btn ghost small" onClick={onClose}>
            Close
          </button>
        </div>
      </header>
      <table className="keys">
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.keys}>
              <td className="key-k">
                <kbd>{s.keys}</kbd>
              </td>
              <td className="key-what">{s.what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </dialog>
  );
}
