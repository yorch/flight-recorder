import { setTimeout as sleep } from 'node:timers/promises';

export class ProviderHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`HTTP ${status}: ${message}`);
    this.status = status;
  }
}

type FetchFn = typeof fetch;

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const BASE_MS = 1000;
const CAP_MS = 20_000;

/** Parses a Retry-After value (delta seconds or HTTP date) into milliseconds, if present/valid. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | null {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/** Delay before attempt `attempt` (0-based retry index): exponential backoff with ±25% jitter. */
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(CAP_MS, BASE_MS * 2 ** attempt);
  return Math.round(base * (0.75 + rand() * 0.5));
}

export interface PostJsonOpts {
  attempts?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
}

/**
 * POSTs JSON, returning the parsed body. Retries network failures and retryable statuses
 * with jittered exponential backoff, honoring Retry-After. Non-retryable statuses throw
 * ProviderHttpError immediately with the provider's error message.
 */
export async function postJson<T = unknown>(
  fetchFn: FetchFn,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: PostJsonOpts = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const doSleep = opts.sleep ?? ((ms: number) => sleep(ms));
  const serialized = JSON.stringify(body);

  let lastErr: unknown = new Error('postJson: no attempts');
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: serialized,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await resp.text();
      let data: unknown = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = {};
      }
      if (resp.ok) return data as T;
      const msg = (data as { error?: { message?: string } }).error?.message ?? (data as { message?: string }).message ?? text.slice(0, 300);
      if (!RETRYABLE_STATUS.has(resp.status)) throw new ProviderHttpError(resp.status, msg);
      lastErr = new ProviderHttpError(resp.status, msg);
      if (i === attempts - 1) break;
      const wait = retryAfterMs(resp.headers) ?? backoffMs(i, opts.rand ?? Math.random);
      await doSleep(Math.min(CAP_MS * 2, wait));
    } catch (err) {
      if (err instanceof ProviderHttpError) throw err;
      lastErr = err; // network error / abort
      if (i === attempts - 1) break;
      await doSleep(backoffMs(i, opts.rand ?? Math.random));
    }
  }
  throw lastErr;
}
