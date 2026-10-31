// GET /api/runs/:id/network — the run's HTTP request log. Entries come from the
// browser (CDP) when available, otherwise from the Squid access log; any field
// may be missing, so everything is normalised defensively here.

export type NetworkSource = 'cdp' | 'proxy' | 'none';

export interface NetworkEntry {
  seq: number;
  t_ms: number | null;
  method: string;
  url: string;
  resource_type: string | null;
  status: number | null;
  ms: number | null;
  cached: boolean;
  error: string | null;
  headers_out: [string, string][];
  headers_in: [string, string][];
  squid_result: string | null;
}

export interface NetworkLog {
  entries: NetworkEntry[];
  truncated: boolean;
  source: NetworkSource;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function headers(v: unknown): [string, string][] {
  if (Array.isArray(v)) {
    const out: [string, string][] = [];
    for (const h of v) {
      if (Array.isArray(h) && h.length >= 2) out.push([String(h[0]), String(h[1])]);
      else if (h && typeof h === 'object' && 'name' in h) out.push([String(h.name), String((h as { value?: unknown }).value ?? '')]);
    }
    return out;
  }
  if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x)]);
  return [];
}

export function normalizeNetwork(raw: unknown): NetworkLog {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const source: NetworkSource = o.source === 'cdp' || o.source === 'proxy' ? o.source : 'none';
  const list = Array.isArray(o.entries) ? o.entries : [];
  const entries = list
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e, i) => ({
      seq: num(e.seq) ?? i + 1,
      t_ms: num(e.t_ms),
      method: (str(e.method) ?? 'GET').toUpperCase(),
      url: str(e.url) ?? '',
      resource_type: str(e.resource_type),
      status: num(e.status),
      ms: num(e.ms),
      cached: e.cached === true,
      error: str(e.error),
      headers_out: headers(e.headers_out),
      headers_in: headers(e.headers_in),
      squid_result: str(e.squid_result),
    }));
  return { entries, truncated: o.truncated === true, source };
}

/** Host (with non-default port) of a URL; CONNECT targets ('host:443') are kept as-is. */
export function domainOf(url: string): string {
  if (/^[^/\s:]+:\d+$/.test(url)) return url;
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Filter bucket for a status: '2xx' … '5xx', 'failed' (error/no status), or 'pending'. */
export function statusClass(e: Pick<NetworkEntry, 'status' | 'error'>): string {
  if (e.error) return 'failed';
  if (e.status === null) return 'pending';
  if (e.status === 0) return 'failed';
  return `${Math.floor(e.status / 100)}xx`;
}

/** Short outcome text: the error, else the proxy verdict, else 'cached'. */
export const resultOf = (e: Pick<NetworkEntry, 'error' | 'squid_result' | 'cached'>): string =>
  e.error ?? e.squid_result ?? (e.cached ? 'cached' : '');

export const SOURCE_NOTE: Record<NetworkSource, string | null> = {
  cdp: null,
  proxy: 'Source: proxy access log. Resource types, headers and per-request timings from the browser are unavailable for this run.',
  none: 'No request log was recorded for this run.',
};
