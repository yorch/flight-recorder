import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageSizeOpenAI, OpenAIClient } from '../../src/agent/providers/openai.ts';

const must = <T>(v: T | null | undefined): NonNullable<T> => {
  assert.ok(v != null, 'expected non-null value');
  return v;
};

const patches = (w: number, h: number) => Math.ceil(w / 32) * Math.ceil(h / 32);

describe('imageSizeOpenAI', () => {
  it('1920x1080 unchanged', () => assert.deepEqual(imageSizeOpenAI(1920, 1080), { width: 1920, height: 1080 }));
  it('8000x4000 fits both limits', () => {
    const r = imageSizeOpenAI(8000, 4000);
    assert.ok(r.width <= 6000 && r.height <= 6000);
    assert.ok(patches(r.width, r.height) <= 10000, JSON.stringify(r));
  });
  it('4000x4000 <= 10000 patches', () => {
    const r = imageSizeOpenAI(4000, 4000);
    assert.ok(patches(r.width, r.height) <= 10000, JSON.stringify(r));
  });
  it('preserves aspect ratio roughly', () => {
    const r = imageSizeOpenAI(8000, 2000);
    assert.ok(Math.abs(r.width / r.height - 4) < 0.2);
    assert.ok(patches(r.width, r.height) <= 10000);
  });
});

describe('OpenAIClient.next', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
  fs.writeFileSync(path.join(dir, 'OPENAI_API_KEY'), 'okey\n');
  const spec = { name: 't', start_url: '', goal: 'g', allowed_origins: [] } as never;

  it('sends responses request and parses output_text content', async () => {
    let seenBody: unknown = null;
    let seenHeaders: Record<string, string> | null = null;
    const fetchFn = async (_u: unknown, init?: RequestInit) => {
      seenHeaders = must(init).headers as Record<string, string>;
      seenBody = JSON.parse(String(must(init).body));
      return new Response(
        JSON.stringify({
          output: [
            { type: 'message', content: [{ type: 'output_text', text: '{"action":{"kind":"done","status":"PASSED","summary":"ok"}}' }] },
          ],
          usage: { input_tokens: 3, output_tokens: 5 },
        }),
        { status: 200 },
      );
    };
    const c = new OpenAIClient({ model: 'gpt-5', secretsDir: dir, fetchFn: fetchFn as typeof fetch });
    const reply = await c.next({
      spec,
      observation: { step_id: 's1', url: 'u', title: 't', screenshot: { png: Buffer.from('X'), width: 100, height: 100 } },
      history: [],
      schema: {},
    });
    assert.equal(must<Record<string, string>>(seenHeaders).Authorization, 'Bearer okey');
    const b = seenBody as { text: { format: { type: string; name: string; strict: boolean } }; input: { content: { type: string }[] }[] };
    assert.equal(b.text.format.type, 'json_schema');
    assert.equal(b.text.format.name, 'agent_turn');
    assert.equal(b.text.format.strict, true);
    assert.equal(b.input[0].content[0].type, 'input_image');
    assert.equal(b.input[0].content[1].type, 'input_text');
    assert.deepEqual(reply.usage, { input_tokens: 3, output_tokens: 5 });
    assert.equal((reply.raw as { action: { kind: string } }).action.kind, 'done');
  });

  it('falls back to top-level output_text', async () => {
    const c = new OpenAIClient({
      model: 'gpt-5',
      secretsDir: dir,
      fetchFn: (async () => new Response(JSON.stringify({ output_text: '{"a":1}', usage: {} }), { status: 200 })) as typeof fetch,
    });
    const r = await c.next({ spec, observation: {} as never, history: [], schema: {} });
    assert.deepEqual(r.raw, { a: 1 });
  });

  it('turns a refusal into a done/FAILED action', async () => {
    const c = new OpenAIClient({
      model: 'gpt-5',
      secretsDir: dir,
      fetchFn: (async () =>
        new Response(JSON.stringify({ output: [{ content: [{ type: 'refusal', refusal: 'cannot' }] }], usage: {} }), {
          status: 200,
        })) as typeof fetch,
    });
    const r = await c.next({ spec, observation: {} as never, history: [], schema: {} });
    const a = (r.raw as { action: { kind: string; status: string; summary: string } }).action;
    assert.equal(a.kind, 'done');
    assert.equal(a.status, 'FAILED');
    assert.match(a.summary, /cannot/);
  });

  it('throws on API error and empty output', async () => {
    const bad = new OpenAIClient({
      model: 'gpt-5',
      secretsDir: dir,
      fetchFn: (async () => new Response('{}', { status: 500 })) as typeof fetch,
    });
    await assert.rejects(() => bad.next({ spec, observation: {} as never, history: [], schema: {} }), /HTTP 500/);
    const empty = new OpenAIClient({
      model: 'gpt-5',
      secretsDir: dir,
      fetchFn: (async () => new Response('{"output":[]}', { status: 200 })) as typeof fetch,
    });
    await assert.rejects(() => empty.next({ spec, observation: {} as never, history: [], schema: {} }), /no output text/);
    // A 500 is retryable: postJson backs off four times before throwing (~7s).
  }, 30_000);

  it('imageSize uses the OpenAI limiter', () => {
    const c = new OpenAIClient({ model: 'gpt-5', secretsDir: dir, fetchFn: fetch });
    assert.deepEqual(c.imageSize({ width: 1920, height: 1080 }), { width: 1920, height: 1080 });
  });
});
