import { describe, expect, it } from 'vitest';
import {
  applyTable,
  type ColumnSpec,
  compareCells,
  cycleSort,
  emptyState,
  facetOptions,
  filterRows,
  isFiltered,
  readTableState,
  sortRows,
  type TableState,
  writeTableState,
} from './table.ts';

interface Row {
  id: string;
  name: string | null;
  n: number | null;
  kind: string;
}
const rows: Row[] = [
  { id: 'a', name: 'step 10', n: 3, kind: 'click' },
  { id: 'b', name: 'step 2', n: null, kind: 'type' },
  { id: 'c', name: null, n: 1, kind: 'click' },
  { id: 'd', name: 'Step 1', n: 3, kind: 'scroll' },
];
const cols: ColumnSpec<Row>[] = [
  { key: 'name', label: 'Name', value: (r) => r.name, filter: 'text' },
  { key: 'n', label: 'N', value: (r) => r.n, searchable: false },
  { key: 'kind', label: 'Kind', value: (r) => r.kind, filter: 'select' },
  { key: 'fixed', label: 'Fixed', value: (r) => r.id, sortable: false },
];
const ids = (rs: Row[]) => rs.map((r) => r.id).join('');
const st = (patch: Partial<TableState>): TableState => ({ ...emptyState(), ...patch });

describe('cycleSort', () => {
  it('cycles asc → desc → none and restarts on another column', () => {
    const a = cycleSort(null, 'n');
    expect(a).toEqual({ key: 'n', dir: 'asc' });
    const d = cycleSort(a, 'n');
    expect(d).toEqual({ key: 'n', dir: 'desc' });
    expect(cycleSort(d, 'n')).toBeNull();
    expect(cycleSort(d, 'name')).toEqual({ key: 'name', dir: 'asc' });
  });
});

describe('sortRows', () => {
  it('sorts numbers numerically, stably, with blanks last in both directions', () => {
    expect(ids(sortRows(rows, cols, { key: 'n', dir: 'asc' }))).toBe('cadb');
    expect(ids(sortRows(rows, cols, { key: 'n', dir: 'desc' }))).toBe('adcb');
  });
  it('uses natural, case-insensitive string order', () => {
    expect(ids(sortRows(rows, cols, { key: 'name', dir: 'asc' }))).toBe('dbac');
    expect(ids(sortRows(rows, cols, { key: 'name', dir: 'desc' }))).toBe('abdc');
  });
  it('ignores no sort, unknown and unsortable columns, and never mutates input', () => {
    const copy = [...rows];
    expect(ids(sortRows(rows, cols, null))).toBe('abcd');
    expect(ids(sortRows(rows, cols, { key: 'nope', dir: 'asc' }))).toBe('abcd');
    expect(ids(sortRows(rows, cols, { key: 'fixed', dir: 'desc' }))).toBe('abcd');
    expect(rows).toEqual(copy);
  });
  it('compareCells handles booleans and mixed values', () => {
    expect(compareCells(false, true)).toBeLessThan(0);
    expect(compareCells('a2', 'a10')).toBeLessThan(0);
    expect(compareCells(2, 10)).toBeLessThan(0);
  });
});

describe('filterRows', () => {
  it('select filters match the facet exactly; text filters by substring', () => {
    expect(ids(filterRows(rows, cols, st({ filters: { kind: 'click' } })))).toBe('ac');
    expect(ids(filterRows(rows, cols, st({ filters: { name: 'STEP 1' } })))).toBe('ad');
    expect(ids(filterRows(rows, cols, st({ filters: { kind: '' } })))).toBe('abcd');
  });
  it('global search spans searchable columns, or a custom haystack', () => {
    expect(ids(filterRows(rows, cols, st({ q: 'scroll' })))).toBe('d');
    expect(ids(filterRows(rows, cols, st({ q: '3' })))).toBe('');
    expect(ids(filterRows(rows, cols, st({ q: 'b' }), (r) => r.id))).toBe('b');
  });
  it('honours a custom matcher (virtual groups)', () => {
    const grouped: ColumnSpec<Row>[] = [
      { ...cols[2], matches: (r, w) => (w === 'pointer' ? r.kind !== 'type' : r.kind === w) } as ColumnSpec<Row>,
    ];
    expect(ids(filterRows(rows, grouped, st({ filters: { kind: 'pointer' } })))).toBe('acd');
  });
  it('applyTable filters then sorts', () => {
    expect(ids(applyTable(rows, cols, st({ filters: { kind: 'click' }, sort: { key: 'n', dir: 'asc' } })))).toBe('ca');
  });
});

describe('facetOptions / isFiltered', () => {
  it('lists distinct values with counts', () => {
    expect(facetOptions(rows, cols[2] as ColumnSpec<Row>)).toEqual([
      { value: 'click', count: 2 },
      { value: 'scroll', count: 1 },
      { value: 'type', count: 1 },
    ]);
    expect(facetOptions(rows, cols[0] as ColumnSpec<Row>).map((o) => o.value)).toEqual(['Step 1', 'step 2', 'step 10']);
  });
  it('detects active search/filters but not sort alone', () => {
    expect(isFiltered(st({ sort: { key: 'n', dir: 'asc' } }))).toBe(false);
    expect(isFiltered(st({ q: ' x ' }))).toBe(true);
    expect(isFiltered(st({ filters: { kind: '' } }))).toBe(false);
    expect(isFiltered(st({ filters: { kind: 'click' } }))).toBe(true);
  });
});

describe('URL state', () => {
  it('round-trips through URLSearchParams', () => {
    const s = st({ sort: { key: 'n', dir: 'desc' }, q: 'hello world', filters: { kind: 'click', name: 'a&b' } });
    const p = writeTableState(new URLSearchParams(), '', s);
    expect(p.toString()).toBe('sort=n%3Adesc&q=hello+world&f.kind=click&f.name=a%26b');
    expect(readTableState(p)).toEqual(s);
  });
  it('namespaces keep tables independent and preserve foreign keys', () => {
    const base = new URLSearchParams('sort=title:asc&f.status=failed&other=1');
    const p = writeTableState(base, 'net', st({ sort: { key: 'ms', dir: 'asc' }, filters: { method: 'POST' } }));
    expect(readTableState(p)).toEqual(st({ sort: { key: 'title', dir: 'asc' }, filters: { status: 'failed' } }));
    expect(readTableState(p, 'net')).toEqual(st({ sort: { key: 'ms', dir: 'asc' }, filters: { method: 'POST' } }));
    expect(p.get('other')).toBe('1');
    const cleared = writeTableState(p, 'net', emptyState());
    expect([...cleared.keys()].some((k) => k.startsWith('net.'))).toBe(false);
    expect(cleared.get('f.status')).toBe('failed');
  });
  it('drops malformed sort values and empty filters', () => {
    expect(readTableState(new URLSearchParams('sort=n:sideways&f.kind='))).toEqual(emptyState());
  });
});
