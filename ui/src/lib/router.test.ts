import { afterEach, describe, expect, it } from 'vitest';
import { buildHash, currentParams, parseHash, replaceQuery, splitHash } from './router.ts';

describe('hash router', () => {
  afterEach(() => {
    window.location.hash = '';
  });
  it('parses routes with and without a query', () => {
    expect(parseHash('')).toEqual({ name: 'list' });
    expect(parseHash('#/?sort=title:asc')).toEqual({ name: 'list' });
    expect(parseHash('#/new')).toEqual({ name: 'new' });
    expect(parseHash('#/run/20261030-120000-aaaa')).toEqual({ name: 'run', id: '20261030-120000-aaaa' });
    expect(parseHash('#/run/20261030-120000-aaaa?net.f.method=GET')).toEqual({ name: 'run', id: '20261030-120000-aaaa' });
    expect(parseHash('#/run/../../etc')).toEqual({ name: 'list' });
  });
  it('splits and builds hashes', () => {
    expect(splitHash('#/run/x?a=1&b=2')).toEqual({ path: '/run/x', query: 'a=1&b=2' });
    expect(splitHash('#?q=1')).toEqual({ path: '/', query: 'q=1' });
    expect(buildHash('/', new URLSearchParams())).toBe('#/');
    expect(buildHash('/', new URLSearchParams('q=a b'))).toBe('#/?q=a+b');
  });
  it('replaceQuery rewrites only the query and notifies listeners', () => {
    window.location.hash = '#/run/20261030-120000-aaaa';
    let fired = 0;
    const on = () => fired++;
    window.addEventListener('hashquerychange', on);
    replaceQuery(new URLSearchParams('net.sort=ms:desc'));
    expect(window.location.hash).toBe('#/run/20261030-120000-aaaa?net.sort=ms:desc'.replace(':', '%3A'));
    expect(currentParams().get('net.sort')).toBe('ms:desc');
    replaceQuery(new URLSearchParams('net.sort=ms:desc'));
    expect(fired).toBe(1);
    window.removeEventListener('hashquerychange', on);
  });
});
