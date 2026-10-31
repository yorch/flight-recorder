import { createWriteStream, type WriteStream } from 'node:fs';
import type { Page, Request } from 'playwright-core';
import { parseAccessLogLine } from './egress.ts';
import { redact } from './secrets.ts';

/** One line of `network.jsonl`: request/response headers only, never bodies (§15.6). */
export interface NetworkEntry {
  seq: number;
  t_ms: number;
  method: string;
  url: string;
  resource_type: string;
  status: number | null;
  ms: number | null;
  error: string | null;
  cached?: boolean;
  headers_out: Record<string, string>;
  headers_in: Record<string, string>;
}

type Pending = { seq: number; t_ms: number; headers_out: Record<string, string> };

const REQ_HEADERS = ['referer', 'content-type', 'accept'];
const RES_HEADERS = ['content-type', 'content-length'];
const pick = (headers: Record<string, string>, names: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const n of names) if (headers[n]) out[n] = headers[n];
  return out;
};

/**
 * Appends one JSON object per request to `network.jsonl`. The stream opens lazily
 * on the first write, so a run that sees no traffic legitimately leaves an empty
 * or absent file. `seq` is shared across every page the session adopts. Entries
 * are emitted on requestfinished/requestfailed; requests still in flight at
 * close() are flushed with `status: null`.
 */
export class NetworkLog {
  private stream: WriteStream | null = null;
  private closed = false;
  private seq = 0;
  private readonly pending = new Map<Request, Pending>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  attach(page: Page): void {
    page.on('request', (r) => {
      this.pending.set(r, { seq: this.seq++, t_ms: Date.now(), headers_out: pick(r.headers(), REQ_HEADERS) });
    });
    page.on('requestfinished', (r) => this.track(this.finish(r, false)));
    page.on('requestfailed', (r) => this.track(this.finish(r, true)));
  }

  private track(p: Promise<void>): void {
    this.inFlight.add(p);
    void p.then(() => this.inFlight.delete(p));
  }

  private write(entry: NetworkEntry): void {
    if (this.closed) return;
    if (!this.stream) {
      this.stream = createWriteStream(this.file, { flags: 'a' });
      this.stream.on('error', () => {}); // a logging failure must never kill the run
    }
    this.stream.write(`${redact(JSON.stringify(entry))}\n`);
  }

  private async finish(r: Request, failed: boolean): Promise<void> {
    try {
      const p = this.pending.get(r);
      if (!p) return;
      this.pending.delete(r);
      const res = failed ? null : await r.response().catch(() => null);
      const timing = r.timing();
      const entry: NetworkEntry = {
        seq: p.seq,
        t_ms: p.t_ms,
        method: r.method(),
        url: r.url(),
        resource_type: r.resourceType(),
        status: res?.status() ?? null,
        ms: timing.responseEnd >= 0 ? Math.round(timing.responseEnd) : null,
        error: failed ? (r.failure()?.errorText ?? null) : null,
        headers_out: p.headers_out,
        headers_in: pick(res?.headers() ?? {}, RES_HEADERS),
      };
      if (res?.fromServiceWorker()) entry.cached = true;
      this.write(entry);
    } catch {
      /* network logging must never break the run */
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.inFlight]);
    for (const [r, p] of this.pending) {
      this.write({
        seq: p.seq,
        t_ms: p.t_ms,
        method: r.method(),
        url: r.url(),
        resource_type: r.resourceType(),
        status: null,
        ms: null,
        error: null,
        headers_out: p.headers_out,
        headers_in: {},
      });
    }
    this.pending.clear();
    this.closed = true;
    const s = this.stream;
    this.stream = null;
    if (s) await new Promise<void>((resolve) => s.end(resolve));
  }
}

export const NETWORK_ENTRIES_CAP = 5000;

export interface NetworkEntriesResult {
  entries: Record<string, unknown>[];
  truncated: boolean;
  source: 'cdp' | 'proxy' | 'none';
}

/**
 * Shapes `network.jsonl` for `GET /api/runs/:id/network` (§16.2), capped at
 * NETWORK_ENTRIES_CAP. Falls back to `logs/proxy-access.log` (`source: 'proxy'`)
 * when the file is missing or yields no entries; `source: 'none'` when neither exists.
 */
export function networkEntries(
  jsonl: string | null | undefined,
  proxyLog: string | null | undefined,
  cap = NETWORK_ENTRIES_CAP,
): NetworkEntriesResult {
  const cdp: Record<string, unknown>[] = [];
  for (const line of (jsonl ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as unknown;
      if (e !== null && typeof e === 'object' && !Array.isArray(e)) cdp.push(e as Record<string, unknown>);
    } catch {
      /* partially written trailing line */
    }
  }
  if (cdp.length > 0) return { entries: cdp.slice(0, cap), truncated: cdp.length > cap, source: 'cdp' };

  const proxy: Record<string, unknown>[] = [];
  for (const line of (proxyLog ?? '').split('\n')) {
    const e = parseAccessLogLine(line);
    if (!e) continue;
    proxy.push({
      seq: proxy.length,
      t_ms: Math.round(e.epoch_s * 1000),
      method: e.method,
      url: e.url,
      status: e.status,
      resource_type: null,
      ms: null,
      error: null,
      squid_result: e.result,
    });
  }
  if (proxy.length > 0) return { entries: proxy.slice(0, cap), truncated: proxy.length > cap, source: 'proxy' };
  return { entries: [], truncated: false, source: 'none' };
}
