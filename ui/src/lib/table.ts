// Pure table model shared by every data table: tri-state column sorting,
// per-column select/text filters, a global search, and (de)serialisation of that
// state to URL params so a view is shareable (`sort=col:asc`, `q=…`, `f.col=…`,
// optionally namespaced: `net.sort=…`).

export type SortDir = 'asc' | 'desc';
export interface Sort {
  key: string;
  dir: SortDir;
}
export interface TableState {
  sort: Sort | null;
  q: string;
  filters: Record<string, string>;
}
export type Cell = string | number | boolean | null | undefined;

export interface ColumnSpec<T> {
  key: string;
  label: string;
  /** Sort key (and default search/filter text). */
  value: (row: T) => Cell;
  /** Value used by the column filter; defaults to String(value). */
  facet?: (row: T) => string;
  /** Option label for a facet value in select filters. */
  facetLabel?: (facet: string) => string;
  filter?: 'select' | 'text';
  /** Custom filter predicate (e.g. virtual groups like 'active'); defaults to facet equality / substring. */
  matches?: (row: T, want: string) => boolean;
  sortable?: boolean;
  searchable?: boolean;
}

export const emptyState = (): TableState => ({ sort: null, q: '', filters: {} });

/** Header click: asc → desc → none; a different column starts at asc. */
export function cycleSort(cur: Sort | null, key: string): Sort | null {
  if (!cur || cur.key !== key) return { key, dir: 'asc' };
  return cur.dir === 'asc' ? { key, dir: 'desc' } : null;
}

const isBlank = (v: Cell): boolean => v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v));
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Ascending comparison; numbers numerically, strings with natural ordering. */
export function compareCells(a: Cell, b: Cell): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return collator.compare(String(a), String(b));
}

/** Stable sort; blank values always sink to the bottom whatever the direction. */
export function sortRows<T>(rows: readonly T[], cols: readonly ColumnSpec<T>[], sort: Sort | null): T[] {
  const col = sort && cols.find((c) => c.key === sort.key && c.sortable !== false);
  if (!sort || !col) return [...rows];
  const sign = sort.dir === 'asc' ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: col.value(row) }))
    .sort((x, y) => {
      const bx = isBlank(x.v);
      const by = isBlank(y.v);
      if (bx || by) return bx === by ? x.i - y.i : bx ? 1 : -1;
      return sign * compareCells(x.v, y.v) || x.i - y.i;
    })
    .map((x) => x.row);
}

export function facetOf<T>(col: ColumnSpec<T>, row: T): string {
  if (col.facet) return col.facet(row);
  const v = col.value(row);
  return isBlank(v) ? '' : String(v);
}

export function filterRows<T>(rows: readonly T[], cols: readonly ColumnSpec<T>[], state: TableState, haystack?: (row: T) => string): T[] {
  const active = cols.filter((c) => c.filter && state.filters[c.key]);
  const q = state.q.trim().toLowerCase();
  const searchable = cols.filter((c) => c.searchable !== false);
  return rows.filter((row) => {
    for (const c of active) {
      const want = state.filters[c.key] ?? '';
      if (c.matches) {
        if (!c.matches(row, want)) return false;
        continue;
      }
      const got = facetOf(c, row);
      if (c.filter === 'select' ? got !== want : !got.toLowerCase().includes(want.toLowerCase())) return false;
    }
    if (!q) return true;
    const text = haystack ? haystack(row) : searchable.map((c) => facetOf(c, row)).join(' ');
    return text.toLowerCase().includes(q);
  });
}

export const applyTable = <T>(rows: readonly T[], cols: readonly ColumnSpec<T>[], state: TableState, haystack?: (row: T) => string): T[] =>
  sortRows(filterRows(rows, cols, state, haystack), cols, state.sort);

/** Distinct non-empty facet values with counts, naturally ordered. */
export function facetOptions<T>(rows: readonly T[], col: ColumnSpec<T>): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const f = facetOf(col, r);
    if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => collator.compare(a, b)).map(([value, count]) => ({ value, count }));
}

export const isFiltered = (s: TableState): boolean => s.q.trim() !== '' || Object.values(s.filters).some(Boolean);

const pfx = (ns: string) => (ns ? `${ns}.` : '');

export function readTableState(params: URLSearchParams, ns = ''): TableState {
  const p = pfx(ns);
  const sortRaw = params.get(`${p}sort`) ?? '';
  const m = /^(.+):(asc|desc)$/.exec(sortRaw);
  const filters: Record<string, string> = {};
  for (const [k, v] of params) {
    if (k.startsWith(`${p}f.`) && v) filters[k.slice(p.length + 2)] = v;
  }
  return { sort: m?.[1] ? { key: m[1], dir: m[2] as SortDir } : null, q: params.get(`${p}q`) ?? '', filters };
}

/** Returns a copy of `params` with this table's keys replaced; other keys (other tables) are kept. */
export function writeTableState(params: URLSearchParams, ns: string, state: TableState): URLSearchParams {
  const p = pfx(ns);
  const next = new URLSearchParams();
  for (const [k, v] of params) {
    if (k === `${p}sort` || k === `${p}q` || k.startsWith(`${p}f.`)) continue;
    next.append(k, v);
  }
  if (state.sort) next.set(`${p}sort`, `${state.sort.key}:${state.sort.dir}`);
  if (state.q) next.set(`${p}q`, state.q);
  for (const [k, v] of Object.entries(state.filters).sort(([a], [b]) => a.localeCompare(b))) if (v) next.set(`${p}f.${k}`, v);
  return next;
}
