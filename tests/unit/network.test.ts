import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page, Request } from 'playwright-core';
import { NETWORK_ENTRIES_CAP, NetworkLog, networkEntries } from '../../src/network.ts';
import { _resetSecrets, loadSecrets } from '../../src/secrets.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'network-test-'));

const cdpLine = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    seq: 0,
    t_ms: 1234,
    method: 'GET',
    url: 'http://app.test/',
    resource_type: 'document',
    status: 200,
    ms: 12,
    error: null,
    headers_out: { accept: 'text/html' },
    headers_in: { 'content-type': 'text/html' },
    ...over,
  });

describe('networkEntries (GET /api/runs/:id/network shaping)', () => {
  it('parses network.jsonl lines, skips blanks and a torn tail line', () => {
    const jsonl = `${cdpLine()}\n${cdpLine({ seq: 1, method: 'POST', status: 302 })}\n\n{"seq":2,"met\n[1,2]\nnull\n`;
    const r = networkEntries(jsonl, null);
    assert.equal(r.source, 'cdp');
    assert.equal(r.truncated, false);
    assert.equal(r.entries.length, 2); // torn line, arrays and null are dropped
    assert.equal((r.entries[0] as { url: string }).url, 'http://app.test/');
    assert.equal((r.entries[1] as { status: number }).status, 302);
  });

  it('caps entries and sets truncated', () => {
    const jsonl = Array.from({ length: 7 }, (_, i) => cdpLine({ seq: i })).join('\n');
    const r = networkEntries(jsonl, null, 5);
    assert.equal(r.source, 'cdp');
    assert.equal(r.truncated, true);
    assert.equal(r.entries.length, 5);
    assert.equal((r.entries.at(-1) as { seq: number }).seq, 4);
  });

  it('falls back to the proxy access log when network.jsonl is missing or empty', () => {
    const access = [
      '1761800000.123 172.18.0.2 172.18.0.3:3128 GET http://app.test/ 200 TCP_MISS',
      '1761800001.500 172.18.0.2 172.18.0.3:3128 CONNECT evil.test:443 403 TCP_DENIED',
      'garbage line that does not parse',
    ].join('\n');
    for (const jsonl of [null, '', '\n  \n', '{"seq":2,"met\n']) {
      const r = networkEntries(jsonl, access);
      assert.equal(r.source, 'proxy');
      assert.equal(r.entries.length, 2);
      assert.deepEqual(r.entries[0], {
        seq: 0,
        t_ms: 1761800000123,
        method: 'GET',
        url: 'http://app.test/',
        status: 200,
        resource_type: null,
        ms: null,
        error: null,
        squid_result: 'TCP_MISS',
      });
      assert.equal((r.entries[1] as { squid_result: string }).squid_result, 'TCP_DENIED');
    }
  });

  it('caps the proxy fallback too', () => {
    const access = Array.from(
      { length: 6 },
      (_, i) => `176180000${i}.000 172.18.0.2 172.18.0.3:3128 GET http://app.test/${i} 200 TCP_MISS`,
    ).join('\n');
    const r = networkEntries(null, access, 3);
    assert.equal(r.source, 'proxy');
    assert.equal(r.truncated, true);
    assert.equal(r.entries.length, 3);
  });

  it('returns source none when neither file has entries', () => {
    assert.deepEqual(networkEntries(null, null), { entries: [], truncated: false, source: 'none' });
    assert.deepEqual(networkEntries('', 'garbage'), { entries: [], truncated: false, source: 'none' });
  });

  it('honours the exported cap constant', () => {
    assert.equal(NETWORK_ENTRIES_CAP, 5000);
  });
});

describe('NetworkLog', () => {
  type Handler = (r: unknown) => void;
  const fakePage = () => {
    const handlers = new Map<string, Handler>();
    const page = {
      on: (ev: string, cb: Handler) => {
        handlers.set(ev, cb);
        return page;
      },
    } as unknown as Page;
    return { handlers, page };
  };
  const fakeRequest = (over: Record<string, unknown> = {}) =>
    ({
      method: () => 'GET',
      url: () => 'http://app.test/',
      resourceType: () => 'document',
      headers: () => ({ accept: 'text/html', referer: 'http://app.test/home', authorization: 'Bearer x' }),
      timing: () => ({ responseEnd: 42.4 }),
      failure: () => null,
      response: async () => ({
        status: () => 200,
        headers: () => ({ 'content-type': 'text/html', 'content-length': '123', 'set-cookie': 'nope=1' }),
        fromServiceWorker: () => false,
      }),
      ...over,
    }) as unknown as Request;
  const lines = (file: string) =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it('creates the file lazily and logs finished, failed and in-flight requests', async () => {
    const file = path.join(tmp(), 'network.jsonl');
    const log = new NetworkLog(file);
    const { handlers, page } = fakePage();
    log.attach(page);
    assert.equal(fs.existsSync(file), false); // stream opens on first write only

    const ok = fakeRequest();
    handlers.get('request')?.(ok);
    handlers.get('requestfinished')?.(ok);

    const bad = fakeRequest({
      url: () => 'http://app.test/missing',
      resourceType: () => 'xhr',
      timing: () => ({ responseEnd: -1 }),
      failure: () => ({ errorText: 'net::ERR_FAILED' }),
    });
    handlers.get('request')?.(bad);
    handlers.get('requestfailed')?.(bad);

    const inflight = fakeRequest({ url: () => 'http://app.test/pending' });
    handlers.get('request')?.(inflight);
    await log.close();
    await log.close(); // idempotent

    const bySeq = new Map(lines(file).map((e) => [e.seq as number, e]));
    assert.equal(bySeq.size, 3);
    const done = bySeq.get(0) as Record<string, unknown>;
    assert.equal(done.method, 'GET');
    assert.equal(done.url, 'http://app.test/');
    assert.equal(done.resource_type, 'document');
    assert.equal(done.status, 200);
    assert.equal(done.ms, 42);
    assert.equal(done.error, null);
    assert.deepEqual(done.headers_out, { accept: 'text/html', referer: 'http://app.test/home' });
    assert.deepEqual(done.headers_in, { 'content-type': 'text/html', 'content-length': '123' });
    const failed = bySeq.get(1) as Record<string, unknown>;
    assert.equal(failed.status, null);
    assert.equal(failed.ms, null);
    assert.equal(failed.error, 'net::ERR_FAILED');
    const pending = bySeq.get(2) as Record<string, unknown>;
    assert.equal(pending.url, 'http://app.test/pending');
    assert.equal(pending.status, null);
  });

  it('marks service-worker responses cached', async () => {
    const file = path.join(tmp(), 'network.jsonl');
    const log = new NetworkLog(file);
    const { handlers, page } = fakePage();
    log.attach(page);
    const r = fakeRequest({
      response: async () => ({ status: () => 200, headers: () => ({}), fromServiceWorker: () => true }),
    });
    handlers.get('request')?.(r);
    handlers.get('requestfinished')?.(r);
    await log.close();
    assert.equal(lines(file)[0].cached, true);
  });

  it('redacts secret values in logged strings', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'NETPW'), 'hunter2\n');
    loadSecrets(['NETPW'], dir);
    try {
      const file = path.join(dir, 'network.jsonl');
      const log = new NetworkLog(file);
      const { handlers, page } = fakePage();
      log.attach(page);
      const r = fakeRequest({ url: () => 'http://app.test/login?pw=hunter2' });
      handlers.get('request')?.(r);
      handlers.get('requestfailed')?.(r);
      await log.close();
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!text.includes('hunter2'));
      assert.ok(text.includes('{{secret:NETPW}}'));
    } finally {
      _resetSecrets();
    }
  });
});
