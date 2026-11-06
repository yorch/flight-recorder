import type { ReactNode } from 'react';

interface Props {
  title: ReactNode;
  /** Mono readout on the right of the header strip (counts, durations). */
  meta?: ReactNode;
  actions?: ReactNode;
  testId?: string;
  id?: string;
  className?: string;
  children: ReactNode;
}

/** Instrument panel: uppercase header strip + body. */
export function Panel({ title, meta, actions, testId, id, className, children }: Props) {
  return (
    <section className={`panel ${className ?? ''}`} data-testid={testId} id={id}>
      <header className="panel-head">
        <h2>{title}</h2>
        {meta !== undefined && <span className="panel-meta">{meta}</span>}
        {actions && <div className="panel-actions">{actions}</div>}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Banner({ tone = 'idle', children, testId }: { tone?: string; children: ReactNode; testId?: string }) {
  return (
    <div className="banner" data-tone={tone} role={tone === 'bad' ? 'alert' : undefined} data-testid={testId}>
      {children}
    </div>
  );
}
