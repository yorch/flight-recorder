import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkPanel } from './NetworkPanel.tsx';

const RUN = '20261030-120000-aaaa';
const log = {
  source: 'cdp',
  truncated: false,
  entries: [
    {
      seq: 1,
      t_ms: 5,
      method: 'GET',
      url: 'http://app.test/admin/login',
      resource_type: 'Document',
      status: 200,
      ms: 41,
      cached: false,
      error: null,
      headers_out: { accept: 'text/html' },
      headers_in: { 'content-type': 'text/html' },
    },
    { seq: 2, method: 'POST', url: 'http://app.test/api/posts', resource_type: 'XHR', status: 500, ms: 120 },
    {
      seq: 3,
      method: 'GET',
      url: 'http://evil.test/pixel.gif',
      resource_type: 'Image',
      status: null,
      error: 'net::ERR_TUNNEL_CONNECTION_FAILED',
    },
    { seq: 4, method: 'GET', url: 'http://cdn.app.test/app.js', status: 304, ms: 3, cached: true },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const rowsOf = (c: HTMLElement) => [...c.querySelectorAll('[data-testid="network-table"] tbody tr:not(.detail-row)')];
const seqs = (c: HTMLElement) => rowsOf(c).map((tr) => tr.querySelectorAll('td')[1]?.textContent);

describe('NetworkPanel', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    window.location.hash = `#/run/${RUN}`;
    fetchMock = vi.fn(async () => json(log));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  it('renders every request from GET /api/runs/:id/network', async () => {
    const v = render(<NetworkPanel runId={RUN} live={false} />);
    await waitFor(() => expect(seqs(v.container)).toEqual(['1', '2', '3', '4']));
    expect(fetchMock).toHaveBeenCalledWith(`/api/runs/${RUN}/network`);
    const failed = rowsOf(v.container)[2] as HTMLElement;
    expect(failed.className).toContain('row-bad');
    expect(within(failed).getByText('ERR')).toBeTruthy();
    expect(within(failed).getByText('net::ERR_TUNNEL_CONNECTION_FAILED')).toBeTruthy();
    expect(within(rowsOf(v.container)[3] as HTMLElement).getByText('cached')).toBeTruthy();
    expect(v.queryByTestId('network-source')).toBeNull();
  });

  it('filters by method, status class and domain; sorts by time; state goes into the hash', async () => {
    const v = render(<NetworkPanel runId={RUN} live={false} />);
    await waitFor(() => expect(seqs(v.container)).toHaveLength(4));
    fireEvent.change(v.getByLabelText('Filter by Method'), { target: { value: 'POST' } });
    expect(seqs(v.container)).toEqual(['2']);
    expect(window.location.hash).toContain('net.f.method=POST');
    fireEvent.change(v.getByLabelText('Filter by Method'), { target: { value: '' } });
    const status = v.getByLabelText('Filter by Status') as HTMLSelectElement;
    expect([...status.options].map((o) => o.value)).toEqual(['', '2xx', '3xx', '5xx', 'failed']);
    fireEvent.change(status, { target: { value: 'failed' } });
    expect(seqs(v.container)).toEqual(['3']);
    fireEvent.change(status, { target: { value: '' } });
    fireEvent.change(v.getByLabelText('Filter by Domain'), { target: { value: 'app.test' } });
    expect(seqs(v.container)).toEqual(['1', '2']);
    fireEvent.change(v.getByLabelText('Filter by Domain'), { target: { value: '' } });
    const time = within(v.getByRole('columnheader', { name: 'Time' })).getByRole('button');
    fireEvent.click(time);
    fireEvent.click(time);
    expect(seqs(v.container)).toEqual(['2', '1', '4', '3']);
    expect(window.location.hash).toBe(`#/run/${RUN}?net.sort=ms%3Adesc`);
  });

  it('expands a row to show request and response headers', async () => {
    const v = render(<NetworkPanel runId={RUN} live={false} />);
    await waitFor(() => expect(seqs(v.container)).toHaveLength(4));
    fireEvent.click(v.getByLabelText('Show headers for request 1'));
    expect(v.getByText('Request headers')).toBeTruthy();
    expect(v.getByText('accept')).toBeTruthy();
    expect(v.getByText('content-type')).toBeTruthy();
    fireEvent.click(v.getByLabelText('Show headers for request 2'));
    expect(v.getAllByText('Not recorded.')).toHaveLength(2);
  });

  it('copies the URL on click and confirms', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const v = render(<NetworkPanel runId={RUN} live={false} />);
    await waitFor(() => expect(seqs(v.container)).toHaveLength(4));
    const url = v.getByTitle(/api\/posts/);
    expect(url.getAttribute('title')).toContain('http://app.test/api/posts');
    fireEvent.click(url);
    await waitFor(() => expect(within(url).getByText('Copied')).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith('http://app.test/api/posts');
  });

  it('notes a proxy-sourced log and truncation', async () => {
    fetchMock.mockImplementation(async () => json({ ...log, source: 'proxy', truncated: true }));
    const v = render(<NetworkPanel runId={RUN} live={false} />);
    await waitFor(() => expect(v.getByTestId('network-source').textContent).toMatch(/proxy access log/));
    expect(v.getByText(/truncated; showing the first 4/)).toBeTruthy();
  });

  it('reports an absent endpoint without an error banner', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'not found' }, 404));
    const v = render(<NetworkPanel runId={RUN} live={false} />);
    await waitFor(() => expect(v.getByText('The request log is not available for this run.')).toBeTruthy());
    expect(v.queryByRole('alert')).toBeNull();
  });

  it('shows the empty-log note for source none', async () => {
    fetchMock.mockImplementation(async () => json({ source: 'none', truncated: false, entries: [] }));
    const v = render(<NetworkPanel runId={RUN} live={false} />);
    await waitFor(() => expect(v.getByTestId('network-source').textContent).toMatch(/No request log/));
    expect(v.queryByTestId('network-table')).toBeNull();
  });
});
