import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTableState } from '../lib/useTableState.ts';
import { type Column, DataTable } from './DataTable.tsx';

interface Row {
  id: number;
  name: string;
  kind: string;
  ms: number | null;
}
const rows: Row[] = [
  { id: 1, name: 'alpha', kind: 'click', ms: 30 },
  { id: 2, name: 'beta', kind: 'type', ms: 10 },
  { id: 3, name: 'gamma', kind: 'click', ms: null },
];
const columns: Column<Row>[] = [
  { key: 'name', label: 'Name', value: (r) => r.name, filter: 'text' },
  { key: 'kind', label: 'Kind', value: (r) => r.kind, filter: 'select' },
  { key: 'ms', label: 'Time', value: (r) => r.ms, render: (r) => (r.ms === null ? '—' : `${r.ms} ms`) },
];

function Harness({ ns, detail }: { ns: string | null; detail?: boolean }) {
  const [state, setState] = useTableState(ns);
  return (
    <DataTable
      label="Things"
      search="Search things"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      state={state}
      onState={setState}
      testId="things"
      renderDetail={detail ? (r) => <p>detail for {r.name}</p> : undefined}
      detailLabel={(r) => `details ${r.name}`}
    />
  );
}

const bodyNames = (c: HTMLElement) =>
  [...c.querySelectorAll('[data-testid="things"] tbody tr')].map((tr) => tr.querySelector('td')?.textContent);

describe('DataTable', () => {
  beforeEach(() => {
    window.location.hash = '#/';
  });
  afterEach(() => {
    cleanup();
    window.location.hash = '';
  });

  it('cycles sort asc → desc → none from the header with aria-sort and URL state', () => {
    const v = render(<Harness ns="" />);
    const th = v.getByRole('columnheader', { name: /Time/ });
    const btn = within(th).getByRole('button');
    expect(th.getAttribute('aria-sort')).toBe('none');
    fireEvent.click(btn);
    expect(th.getAttribute('aria-sort')).toBe('ascending');
    expect(bodyNames(v.container)).toEqual(['beta', 'alpha', 'gamma']);
    expect(window.location.hash).toBe('#/?sort=ms%3Aasc');
    fireEvent.click(btn);
    expect(th.getAttribute('aria-sort')).toBe('descending');
    expect(bodyNames(v.container)).toEqual(['alpha', 'beta', 'gamma']);
    fireEvent.click(btn);
    expect(th.getAttribute('aria-sort')).toBe('none');
    expect(bodyNames(v.container)).toEqual(['alpha', 'beta', 'gamma']);
    expect(window.location.hash).toBe('#/');
  });

  it('restores sort and filters from a shared URL', () => {
    window.location.hash = '#/?t.sort=name:desc&t.f.kind=click';
    const v = render(<Harness ns="t" />);
    expect(bodyNames(v.container)).toEqual(['gamma', 'alpha']);
    expect((v.getByLabelText('Filter by Kind') as HTMLSelectElement).value).toBe('click');
    expect(v.getByText('2 of 3 rows')).toBeTruthy();
  });

  it('filters by select, text and global search, and clears filters but keeps sort', () => {
    const v = render(<Harness ns={null} />);
    const select = v.getByLabelText('Filter by Kind') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['All', 'click (2)', 'type (1)']);
    fireEvent.change(select, { target: { value: 'click' } });
    expect(bodyNames(v.container)).toEqual(['alpha', 'gamma']);
    fireEvent.change(v.getByLabelText('Filter by Name'), { target: { value: 'GAM' } });
    expect(bodyNames(v.container)).toEqual(['gamma']);
    fireEvent.click(within(v.getByRole('columnheader', { name: /Name/ })).getByRole('button'));
    fireEvent.click(v.getByText('Clear filters'));
    expect(bodyNames(v.container)).toEqual(['alpha', 'beta', 'gamma']);
    expect(v.getByRole('columnheader', { name: /Name/ }).getAttribute('aria-sort')).toBe('ascending');
    fireEvent.change(v.getByLabelText('Search Things'), { target: { value: 'zzz' } });
    expect(v.getByText('No rows match the current filters.')).toBeTruthy();
    // Local state never touches the URL.
    expect(window.location.hash).toBe('#/');
  });

  it('keeps independent namespaces in one hash', () => {
    const v = render(
      <>
        <Harness ns="a" />
        <Harness ns="b" />
      </>,
    );
    const [first, second] = v.getAllByLabelText('Filter by Kind') as HTMLSelectElement[];
    act(() => {
      fireEvent.change(first as HTMLSelectElement, { target: { value: 'type' } });
    });
    act(() => {
      fireEvent.change(second as HTMLSelectElement, { target: { value: 'click' } });
    });
    const params = new URLSearchParams(window.location.hash.split('?')[1]);
    expect(params.get('a.f.kind')).toBe('type');
    expect(params.get('b.f.kind')).toBe('click');
  });

  it('expands a row into a detail row', () => {
    const v = render(<Harness ns={null} detail />);
    const toggle = v.getByLabelText('details beta');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(v.getByText('detail for beta')).toBeTruthy();
    fireEvent.click(toggle);
    expect(v.queryByText('detail for beta')).toBeNull();
  });
});
