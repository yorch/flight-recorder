import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { navigationError } from '../../src/interaction.ts';

describe('navigationError', () => {
  it('accepts 2xx/3xx and same-document navigations (no response)', () => {
    assert.equal(navigationError('http://app.test/', 200), null);
    assert.equal(navigationError('http://app.test/', 304), null);
    assert.equal(navigationError('http://app.test/#x', null), null);
  });

  it('fails HTTP errors and names Squid error pages', () => {
    assert.equal(navigationError('http://app.test/nope', 404), 'Navigation to http://app.test/nope returned HTTP 404');
    assert.equal(
      navigationError('http://app.test/', 503, { 'x-squid-error': 'ERR_DNS_FAIL 0' }),
      'Navigation to http://app.test/ returned HTTP 503 (proxy error: ERR_DNS_FAIL 0)',
    );
    assert.match(
      navigationError('http://evil.test/', 403, { 'x-squid-error': 'ERR_ACCESS_DENIED 0' }) ?? '',
      /HTTP 403 \(proxy error: ERR_ACCESS_DENIED/,
    );
  });
});
