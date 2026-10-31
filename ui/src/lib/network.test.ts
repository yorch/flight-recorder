import { describe, expect, it } from 'vitest';
import { domainOf, normalizeNetwork, resultOf, statusClass } from './network.ts';

describe('normalizeNetwork', () => {
  it('fills defaults for partial entries and keeps known fields', () => {
    const log = normalizeNetwork({
      source: 'cdp',
      truncated: true,
      entries: [
        {
          seq: 4,
          t_ms: 12,
          method: 'post',
          url: 'http://app.test/api',
          resource_type: 'XHR',
          status: 201,
          ms: 33.4,
          cached: false,
          error: null,
          headers_out: { accept: '*/*' },
          headers_in: [['set-cookie', 'a=1'], { name: 'set-cookie', value: 'b=2' }],
        },
        { url: 'http://cdn.app.test/x.js' },
        'garbage',
      ],
    });
    expect(log.source).toBe('cdp');
    expect(log.truncated).toBe(true);
    expect(log.entries).toHaveLength(2);
    expect(log.entries[0]).toMatchObject({ seq: 4, method: 'POST', status: 201, ms: 33.4, headers_out: [['accept', '*/*']] });
    expect(log.entries[0]?.headers_in).toEqual([
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=2'],
    ]);
    expect(log.entries[1]).toMatchObject({ seq: 2, method: 'GET', status: null, ms: null, resource_type: null, headers_in: [] });
  });
  it('treats unknown sources and junk bodies as an empty log', () => {
    expect(normalizeNetwork(null)).toEqual({ entries: [], truncated: false, source: 'none' });
    expect(normalizeNetwork({ source: 'squid', entries: 'x' }).source).toBe('none');
    expect(normalizeNetwork({ source: 'proxy', entries: [] }).source).toBe('proxy');
  });
});

describe('network helpers', () => {
  it('domainOf handles URLs, ports and CONNECT targets', () => {
    expect(domainOf('http://app.test/admin?x=1')).toBe('app.test');
    expect(domainOf('http://app.test:8080/')).toBe('app.test:8080');
    expect(domainOf('llm.test:443')).toBe('llm.test:443');
    expect(domainOf('not a url')).toBe('');
  });
  it('statusClass buckets responses', () => {
    expect(statusClass({ status: 204, error: null })).toBe('2xx');
    expect(statusClass({ status: 302, error: null })).toBe('3xx');
    expect(statusClass({ status: 403, error: null })).toBe('4xx');
    expect(statusClass({ status: 503, error: null })).toBe('5xx');
    expect(statusClass({ status: null, error: null })).toBe('pending');
    expect(statusClass({ status: 0, error: null })).toBe('failed');
    expect(statusClass({ status: 200, error: 'net::ERR_ABORTED' })).toBe('failed');
  });
  it('resultOf prefers the error, then the proxy verdict, then cached', () => {
    expect(resultOf({ error: 'boom', squid_result: 'TCP_DENIED', cached: true })).toBe('boom');
    expect(resultOf({ error: null, squid_result: 'TCP_DENIED', cached: true })).toBe('TCP_DENIED');
    expect(resultOf({ error: null, squid_result: null, cached: true })).toBe('cached');
    expect(resultOf({ error: null, squid_result: null, cached: false })).toBe('');
  });
});
