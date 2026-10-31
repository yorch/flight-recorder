import { Fragment, type ReactNode, useMemo, useState } from 'react';
import { applyTable, type ColumnSpec, cycleSort, emptyState, facetOptions, isFiltered, type TableState } from '../lib/table.ts';

export interface Column<T> extends ColumnSpec<T> {
  render?: (row: T) => ReactNode;
  className?: string;
}

interface Props<T> {
  columns: Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string | number;
  state: TableState;
  onState: (next: TableState) => void;
  /** Accessible name of the table. */
  label: string;
  /** Global search box above the table (omit to hide). */
  search?: string;
  haystack?: (row: T) => string;
  testId?: string;
  className?: string;
  wrapClassName?: string;
  rowClassName?: (row: T) => string;
  /** Makes rows expandable; the content renders in a full-width row below. */
  renderDetail?: (row: T) => ReactNode;
  detailLabel?: (row: T) => string;
  /** Body shown when there are no rows at all. */
  empty?: ReactNode;
  toolbarExtra?: ReactNode;
  /** Noun for the "n of m" readout. */
  noun?: string;
}

const ARIA_SORT = { asc: 'ascending', desc: 'descending' } as const;

/** Sortable, filterable table: header click cycles asc → desc → none; filters sit in a header row. */
export function DataTable<T>(p: Props<T>) {
  const { columns, rows, state, onState } = p;
  const [open, setOpen] = useState<Set<string | number>>(() => new Set());
  const visible = useMemo(() => applyTable(rows, columns, state, p.haystack), [rows, columns, state, p.haystack]);
  const hasFilters = columns.some((c) => c.filter);
  const filtered = isFiltered(state);
  const span = columns.length + (p.renderDetail ? 1 : 0);
  const setFilter = (key: string, value: string) => onState({ ...state, filters: { ...state.filters, [key]: value } });
  const toggle = (k: string | number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (!n.delete(k)) n.add(k);
      return n;
    });

  return (
    <div className="data-table">
      {(p.search !== undefined || p.toolbarExtra || hasFilters) && (
        <div className="toolbar">
          {p.search !== undefined && (
            <input
              type="search"
              aria-label={`Search ${p.label}`}
              placeholder={p.search}
              value={state.q}
              onChange={(e) => onState({ ...state, q: e.target.value })}
            />
          )}
          <span className="muted small table-count" aria-live="polite">
            {filtered ? `${visible.length} of ${rows.length}` : rows.length} {p.noun ?? 'rows'}
          </span>
          {filtered && (
            <button type="button" className="btn small" onClick={() => onState({ ...emptyState(), sort: state.sort })}>
              Clear filters
            </button>
          )}
          {p.toolbarExtra}
        </div>
      )}
      <div className={`table-wrap ${p.wrapClassName ?? ''}`}>
        <table className={p.className} data-testid={p.testId} aria-label={p.label}>
          <thead>
            <tr>
              {p.renderDetail && (
                <th className="col-toggle">
                  <span className="sr-only">Details</span>
                </th>
              )}
              {columns.map((c) => {
                const dir = state.sort?.key === c.key ? state.sort.dir : null;
                if (c.sortable === false) return <th key={c.key}>{c.label}</th>;
                return (
                  <th key={c.key} aria-sort={dir ? ARIA_SORT[dir] : 'none'}>
                    <button type="button" className="sort-btn" onClick={() => onState({ ...state, sort: cycleSort(state.sort, c.key) })}>
                      {c.label}
                      <span className="sort-ind" data-dir={dir ?? 'none'} aria-hidden="true" />
                    </button>
                  </th>
                );
              })}
            </tr>
            {hasFilters && (
              <tr className="filter-row">
                {p.renderDetail && <td />}
                {columns.map((c) => (
                  <td key={c.key}>
                    {c.filter === 'select' && (
                      <select
                        aria-label={`Filter by ${c.label}`}
                        value={state.filters[c.key] ?? ''}
                        onChange={(e) => setFilter(c.key, e.target.value)}
                      >
                        <option value="">All</option>
                        {withSelected(facetOptions(rows, c), state.filters[c.key]).map((o) => (
                          <option key={o.value} value={o.value}>
                            {c.facetLabel ? c.facetLabel(o.value) : o.value}
                            {o.count >= 0 ? ` (${o.count})` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                    {c.filter === 'text' && (
                      <input
                        type="search"
                        aria-label={`Filter by ${c.label}`}
                        placeholder="Filter…"
                        value={state.filters[c.key] ?? ''}
                        onChange={(e) => setFilter(c.key, e.target.value)}
                      />
                    )}
                  </td>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {visible.map((row) => {
              const k = p.rowKey(row);
              const expanded = open.has(k);
              return (
                <Fragment key={k}>
                  <tr className={p.rowClassName?.(row) ?? ''}>
                    {p.renderDetail && (
                      <td className="col-toggle">
                        <button
                          type="button"
                          className="expand-btn"
                          aria-expanded={expanded}
                          aria-label={p.detailLabel?.(row) ?? 'Show details'}
                          onClick={() => toggle(k)}
                        />
                      </td>
                    )}
                    {columns.map((c) => (
                      <td key={c.key} className={c.className}>
                        {c.render ? c.render(row) : String(c.value(row) ?? '')}
                      </td>
                    ))}
                  </tr>
                  {p.renderDetail && expanded && (
                    <tr className="detail-row">
                      <td colSpan={span}>{p.renderDetail(row)}</td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {visible.length === 0 && (
              <tr className="empty-row">
                <td colSpan={span} className="muted">
                  {rows.length === 0 ? (p.empty ?? 'Nothing to show yet.') : 'No rows match the current filters.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Keeps a filter value from the URL selectable even when no row currently has it. */
function withSelected(opts: { value: string; count: number }[], selected: string | undefined) {
  return selected && !opts.some((o) => o.value === selected) ? [...opts, { value: selected, count: -1 }] : opts;
}
