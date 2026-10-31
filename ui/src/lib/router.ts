import { useMemo, useSyncExternalStore } from 'react';

// Tiny hash router: '#/', '#/new', '#/run/<id>', each with an optional '?query'
// that carries shareable view state (sorting, filters, search). No router lib.
export type Route = { name: 'list' } | { name: 'new' } | { name: 'run'; id: string };

const QUERY_EVENT = 'hashquerychange';

export function splitHash(hash: string): { path: string; query: string } {
  const h = hash.replace(/^#/, '') || '/';
  const i = h.indexOf('?');
  return i < 0 ? { path: h, query: '' } : { path: h.slice(0, i) || '/', query: h.slice(i + 1) };
}

export function parseHash(hash: string): Route {
  const { path } = splitHash(hash);
  const m = /^\/run\/([0-9]{8}-[0-9]{6}-[0-9a-f]{4})$/.exec(path);
  if (m?.[1]) return { name: 'run', id: m[1] };
  if (path === '/new') return { name: 'new' };
  return { name: 'list' };
}

export function buildHash(path: string, params: URLSearchParams): string {
  const qs = params.toString();
  return `#${path}${qs ? `?${qs}` : ''}`;
}

const subscribe = (cb: () => void) => {
  window.addEventListener('hashchange', cb);
  window.addEventListener(QUERY_EVENT, cb);
  return () => {
    window.removeEventListener('hashchange', cb);
    window.removeEventListener(QUERY_EVENT, cb);
  };
};
const snapshot = () => window.location.hash;

export function useHash(): string {
  return useSyncExternalStore(subscribe, snapshot, () => '');
}

export function useRoute(): Route {
  const hash = useHash();
  // Memoised on the path so query-only updates keep the same Route object.
  const { path } = splitHash(hash);
  return useMemo(() => parseHash(`#${path}`), [path]);
}

export function useHashParams(): URLSearchParams {
  const hash = useHash();
  return useMemo(() => new URLSearchParams(splitHash(hash).query), [hash]);
}

/** Current query params, read fresh from the location (safe for concurrent writers). */
export const currentParams = (): URLSearchParams => new URLSearchParams(splitHash(window.location.hash).query);

/** Replaces the hash query in place (no history entry per keystroke) and notifies subscribers. */
export function replaceQuery(params: URLSearchParams): void {
  const next = buildHash(splitHash(window.location.hash).path, params);
  if (next === (window.location.hash || '#/')) return;
  window.history.replaceState(window.history.state, '', next);
  window.dispatchEvent(new Event(QUERY_EVENT));
}

export const nav = (to: string): void => {
  window.location.hash = to;
};
