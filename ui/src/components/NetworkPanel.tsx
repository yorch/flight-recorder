import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, apiGet } from '../lib/api.ts';
import { domainOf, type NetworkEntry, type NetworkLog, normalizeNetwork, resultOf, SOURCE_NOTE, statusClass } from '../lib/network.ts';
import { useTableState } from '../lib/useTableState.ts';
import { type Column, DataTable } from './DataTable.tsx';

const STATUS_LABEL: Record<string, string> = { failed: 'failed / blocked', pending: 'no response' };

function Headers({ title, list }: { title: string; list: [string, string][] }) {
  return (
    <div>
      <h4>{title}</h4>
      {list.length === 0 ? (
        <p className="muted small">Not recorded.</p>
      ) : (
        <dl className="headers">
          {list.map(([k, v], i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: header names may repeat (set-cookie)
            <div key={`${k}-${i}`}>
              <dt className="mono">{k}</dt>
              <dd className="mono">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Run detail: the HTTP request log (`GET /api/runs/:id/network`) as a sortable, filterable table. */
export function NetworkPanel({ runId, live }: { runId: string; live: boolean }) {
  const [log, setLog] = useState<NetworkLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [copied, setCopied] = useState<{ seq: number; ok: boolean } | null>(null);
  const [state, setState] = useTableState('net');
  const copyTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      setLog(normalizeNetwork(await apiGet<unknown>(`/api/runs/${runId}/network`)));
      setError(null);
      setMissing(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === 404) setMissing(true);
      else setError(err instanceof Error ? err.message : String(err));
    }
  }, [runId]);

  useEffect(() => {
    void load();
    if (!live) return;
    const iv = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(iv);
  }, [load, live]);

  useEffect(() => () => (copyTimer.current === null ? undefined : window.clearTimeout(copyTimer.current)), []);

  const copy = useCallback(async (e: NetworkEntry) => {
    const ok = await copyText(e.url);
    setCopied({ seq: e.seq, ok });
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(null), 1500);
  }, []);

  const columns = useMemo<Column<NetworkEntry>[]>(
    () => [
      { key: 'seq', label: '#', value: (e) => e.seq, className: 'mono', searchable: false },
      { key: 'method', label: 'Method', value: (e) => e.method, filter: 'select', className: 'mono' },
      {
        key: 'url',
        label: 'URL',
        value: (e) => e.url,
        filter: 'text',
        className: 'col-url',
        render: (e) => (
          <button type="button" className="url-cell mono" title={`${e.url}\nClick to copy`} onClick={() => void copy(e)}>
            {e.url || '(unknown)'}
            {copied?.seq === e.seq && (
              <span className={`copied ${copied.ok ? '' : 'warn'}`} role="status">
                {copied.ok ? 'Copied' : 'Copy failed'}
              </span>
            )}
          </button>
        ),
      },
      { key: 'domain', label: 'Domain', value: (e) => domainOf(e.url), filter: 'select', className: 'mono small' },
      {
        key: 'status',
        label: 'Status',
        value: (e) => e.status,
        facet: (e) => statusClass(e),
        facetLabel: (f) => STATUS_LABEL[f] ?? f,
        filter: 'select',
        render: (e) => <span className={`chip chip-http-${statusClass(e)}`}>{e.status ?? (e.error ? 'ERR' : '—')}</span>,
      },
      { key: 'type', label: 'Type', value: (e) => e.resource_type, filter: 'select', className: 'small' },
      {
        key: 'ms',
        label: 'Time',
        value: (e) => e.ms,
        className: 'mono num',
        render: (e) => (e.ms === null ? '—' : `${Math.round(e.ms)} ms`),
      },
      {
        key: 'result',
        label: 'Result',
        value: (e) => resultOf(e),
        className: 'small',
        render: (e) => <span className={e.error ? 'warn' : 'muted'}>{resultOf(e)}</span>,
      },
    ],
    [copy, copied],
  );

  const note = log ? SOURCE_NOTE[log.source] : null;
  // t_ms is a wall-clock timestamp; show it relative to the first request.
  const t0 = useMemo(() => {
    const ts = (log?.entries ?? []).flatMap((e) => (e.t_ms === null ? [] : [e.t_ms]));
    return ts.length ? Math.min(...ts) : null;
  }, [log]);

  return (
    <section className="panel" data-testid="network-panel">
      <div className="row spread">
        <h3>HTTP requests</h3>
        <button type="button" className="btn small" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      {missing && <p className="muted">The request log is not available for this run.</p>}
      {!log && !missing && !error && (
        <p className="muted" role="status">
          Loading request log…
        </p>
      )}
      {log && (
        <>
          {note && (
            <p className="banner small" data-testid="network-source">
              {note}
            </p>
          )}
          {log.truncated && <p className="banner small">The log was truncated; showing the first {log.entries.length} requests.</p>}
          {(log.source !== 'none' || log.entries.length > 0) && (
            <DataTable
              label="HTTP requests"
              noun="requests"
              search="Search URL, method, status…"
              columns={columns}
              rows={log.entries}
              rowKey={(e) => e.seq}
              state={state}
              onState={setState}
              testId="network-table"
              className="network"
              wrapClassName="network-wrap"
              rowClassName={(e) => (e.error || (e.status ?? 0) >= 400 ? 'row-bad' : '')}
              renderDetail={(e) => (
                <div className="request-detail">
                  <p className="mono small wrap-any">
                    {e.method} {e.url}
                  </p>
                  <div className="grid2">
                    <Headers title="Request headers" list={e.headers_out} />
                    <Headers title="Response headers" list={e.headers_in} />
                  </div>
                  <p className="muted small">
                    {[
                      e.t_ms !== null && t0 !== null ? `+${((e.t_ms - t0) / 1000).toFixed(2)}s after first request` : '',
                      e.cached ? 'served from cache' : '',
                      e.squid_result ? `proxy: ${e.squid_result}` : '',
                      e.error ? `error: ${e.error}` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
              )}
              detailLabel={(e) => `Show headers for request ${e.seq}`}
              empty={live ? 'No requests yet.' : 'No requests were recorded.'}
            />
          )}
        </>
      )}
    </section>
  );
}
