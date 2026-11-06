import { type KeyboardEvent, useRef } from 'react';

export interface TabSpec<K extends string> {
  id: K;
  label: string;
  count?: number | null;
  /** Small tone dot next to the label (e.g. failures in the network log). */
  alert?: boolean;
}

/** WAI-ARIA tablist with roving tabindex; arrows/Home/End move and select. */
export function Tabs<K extends string>({
  tabs,
  active,
  onSelect,
  label,
}: {
  tabs: TabSpec<K>[];
  active: K;
  onSelect: (k: K) => void;
  label: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (i: number) => {
    const n = tabs.length;
    const j = ((i % n) + n) % n;
    const t = tabs[j];
    if (!t) return;
    onSelect(t.id);
    refs.current[j]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === 'ArrowRight') move(i + 1);
    else if (e.key === 'ArrowLeft') move(i - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(tabs.length - 1);
    else return;
    e.preventDefault();
  };
  return (
    <div role="tablist" aria-label={label} className="tabs">
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`tab-${t.id}`}
          aria-selected={active === t.id}
          aria-controls={`panel-${t.id}`}
          tabIndex={active === t.id ? 0 : -1}
          className="tab"
          onClick={() => onSelect(t.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          <kbd className="tab-key">{i + 1}</kbd>
          {t.label}
          {t.count !== undefined && t.count !== null && <span className="tab-count">{t.count}</span>}
          {t.alert && <span className="led" data-tone="bad" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}
