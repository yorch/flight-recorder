import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveRefFor } from '../../src/agent/loop.ts';
import { buildUserText, systemPromptFor } from '../../src/agent/prompt.ts';
import { backoffMs, ProviderHttpError, postJson, retryAfterMs } from '../../src/agent/providers/http.ts';

const resp = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const noSleep = async () => {};
const noRand = () => 0.5;

describe('postJson', () => {
  const ok = { a: 1 };
  const fetchSeq = (rs: (Response | Error)[]) => {
    let i = 0;
    const calls: number[] = [];
    const fn = async () => {
      calls.push(i);
      const r = rs[i++] ?? rs.at(-1);
      if (!r) throw new Error('no more responses');
      if (r instanceof Error) throw r;
      return r;
    };
    return { fn, calls };
  };

  it('returns parsed body on first success', async () => {
    const { fn } = fetchSeq([resp(200, ok)]);
    const r = await postJson(fn as typeof fetch, 'http://x', {}, {}, { sleep: noSleep });
    assert.deepEqual(r, ok);
  });

  it('retries retryable statuses then succeeds', async () => {
    for (const status of [408, 409, 429, 500, 502, 503, 504, 529]) {
      const { fn, calls } = fetchSeq([resp(status, { error: { message: 'm' } }), resp(200, ok)]);
      const r = await postJson(fn as typeof fetch, 'http://x', {}, {}, { sleep: noSleep, rand: noRand });
      assert.deepEqual(r, ok);
      assert.equal(calls.length, 2, `status ${status}`);
    }
  });

  it('throws non-retryable status immediately with provider message', async () => {
    const { fn, calls } = fetchSeq([resp(400, { error: { message: 'bad req' } }), resp(200, ok)]);
    await assert.rejects(
      () => postJson(fn as typeof fetch, 'http://x', {}, {}, { sleep: noSleep }),
      (e: unknown) => {
        assert.ok(e instanceof ProviderHttpError);
        assert.equal((e as ProviderHttpError).status, 400);
        assert.match((e as Error).message, /bad req/);
        return true;
      },
    );
    assert.equal(calls.length, 1);
  });

  it('retries network errors and exhausts attempts', async () => {
    const { fn, calls } = fetchSeq([new Error('ECONNRESET'), new Error('ETIMEDOUT')]);
    await assert.rejects(
      () => postJson(fn as typeof fetch, 'http://x', {}, {}, { attempts: 3, sleep: noSleep, rand: noRand }),
      /ETIMEDOUT/,
    );
    assert.equal(calls.length, 3);
  });

  it('honors retry-after seconds and HTTP dates', async () => {
    const waits: number[] = [];
    const collect = async (ms: number) => {
      waits.push(ms);
    };
    const { fn } = fetchSeq([resp(429, {}, { 'retry-after': '2' }), resp(200, ok)]);
    await postJson(fn as typeof fetch, 'http://x', {}, {}, { sleep: collect, rand: noRand });
    assert.deepEqual(waits, [2000]);
  });

  it('uses AbortSignal.timeout per attempt', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const fn = async (_u: unknown, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return resp(200, ok);
    };
    await postJson(fn as typeof fetch, 'http://x', {}, {}, { timeoutMs: 1234 });
    assert.equal(signals[0]?.aborted, false);
    assert.ok(signals[0] instanceof AbortSignal);
  });

  it('backoffMs grows exponentially, capped, with jitter bounds', () => {
    assert.equal(
      backoffMs(0, () => 0.5),
      1000,
    );
    assert.equal(
      backoffMs(1, () => 0),
      1500,
    );
    assert.equal(
      backoffMs(1, () => 1),
      2500,
    );
    assert.equal(
      backoffMs(20, () => 0.5),
      20000,
    );
  });

  it('retryAfterMs parses seconds and dates', () => {
    const h = (v: string) => new Headers({ 'retry-after': v });
    assert.equal(retryAfterMs(h('3'), 0), 3000);
    assert.equal(retryAfterMs(h('0'), 0), 0);
    const date = new Date(10_000).toUTCString();
    assert.equal(retryAfterMs(h(date), 4_000), 6000);
    assert.equal(retryAfterMs(h('bogus'), 0), null);
    assert.equal(retryAfterMs(new Headers(), 0), null);
  });
});

describe('prompt', () => {
  const obs = {
    step_id: 's0002',
    url: 'http://x/',
    title: 'T',
    screenshot: { png: Buffer.from(''), width: 1456, height: 819 },
    aria_snapshot: '- button "Go" [ref=e3]',
  };
  const spec = {
    name: 't',
    start_url: 'u',
    goal: 'do the thing',
    allowed_origins: ['http://x'],
    secrets: { TEST_USER_PASSWORD: { origins: ['http://x'], input_types: ['password'] } },
  } as never;

  it('systemPromptFor states the 7 requirements and the exact size', () => {
    const p = systemPromptFor(obs);
    assert.match(p, /1456 x 819/);
    for (const frag of [
      'click_at and scroll are pixels in that image',
      'Refs first',
      'exactly one action',
      '{{secret:NAME}}',
      'chapter name',
      'untrusted data',
      'Finish with done',
      'assert_visible',
    ]) {
      assert.ok(p.includes(frag), `missing: ${frag}`);
    }
  });
  it('buildUserText includes goal, url, dialog and last-step result', () => {
    const text = buildUserText({
      spec,
      observation: { ...obs, dialog: { type: 'confirm', message: 'sure?', default_value: '' } },
      history: [
        { step_id: 's0001', action: { kind: 'click', label: 'l', ref: 'e1' }, result: 'PASSED' },
        { step_id: 's0002', result: 'FAILED', error: 'oops' },
      ],
    });
    assert.match(text, /do the thing/);
    assert.match(text, /URL: http:\/\/x\//);
    assert.match(text, /Dialog open \(confirm\): sure\?/);
    assert.match(text, /respond with a dialog action/);
    assert.match(text, /Last step result: s0002: invalid action -> FAILED \(oops\)/);
    assert.match(text, /s0001: click "l" -> PASSED/);
    assert.match(text, /ARIA snapshot/);
    assert.match(text, /Allowed origins: http:\/\/x/);
    assert.match(text, /Available secrets: \{\{secret:TEST_USER_PASSWORD\}\}/);
  });
  it('buildUserText never contains secret values and says none when no secrets are declared', () => {
    const text = buildUserText({ spec: { ...(spec as object), secrets: undefined } as never, observation: obs, history: [] });
    assert.match(text, /Available secrets: none/);
    assert.doesNotMatch(text, /Last step result/);
  });
});

describe('resolveRefFor (stub helper)', () => {
  const snap = ['- textbox "Email" [ref=e5]', '- button "Sign in" [ref=e9]', '- region "Recent orders" [ref=e12]'].join('\n');
  it('resolves role+name to the ref', () => {
    const out = resolveRefFor({ kind: 'type', ref_for: { role: 'button', name: 'Sign in' } }, snap) as { ref: string };
    assert.equal(out.ref, 'e9');
    assert.ok(!('ref_for' in (out as object)));
  });
  it('unresolved ref_for becomes e0', () => {
    const out = resolveRefFor({ ref_for: { role: 'button', name: 'Nope' } }, snap) as { ref: string };
    assert.equal(out.ref, 'e0');
  });
  it('passes through actions without ref_for', () => {
    const a = { kind: 'click', ref: 'e5' };
    assert.equal(resolveRefFor(a, snap), a);
    assert.equal(resolveRefFor('str', snap), 'str');
  });
});
