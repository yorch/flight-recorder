import { useEffect, useState } from 'react';

// Tiny hash router: '#/', '#/new', '#/run/<id>'. Enough for §16.3 — no router lib.
export type Route = { name: 'list' } | { name: 'new' } | { name: 'run'; id: string };

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, '') || '/';
  const m = /^\/run\/([0-9]{8}-[0-9]{6}-[0-9a-f]{4})$/.exec(h);
  if (m?.[1]) return { name: 'run', id: m[1] };
  if (h === '/new') return { name: 'new' };
  return { name: 'list' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const nav = (to: string): void => {
  window.location.hash = to;
};
