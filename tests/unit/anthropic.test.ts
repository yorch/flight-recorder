import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AnthropicClient, resizedSize, TIER_HIGH, TIER_STANDARD, tierFor } from '../../src/agent/providers/anthropic.ts';

const must = <T>(v: T | null | undefined): NonNullable<T> => {
  assert.ok(v != null, 'expected non-null value');
  return v;
};

const S = TIER_STANDARD;
const H = TIER_HIGH;

describe('resizedSize (Anthropic reference cases)', () => {
  const cases: [number, number, number, number, number, number][] = [
    // w,h, tier-maxEdge,maxTokens, expected w,h
    [1920, 1080, S.maxEdge, S.maxTokens, 1456, 819],
    [2000, 1500, S.maxEdge, S.maxTokens, 1269, 952],
    [3840, 2160, S.maxEdge, S.maxTokens, 1456, 819],
    [1920, 1080, H.maxEdge, H.maxTokens, 1920, 1080],
    [3840, 2160, H.maxEdge, H.maxTokens, 2576, 1449],
    [1075, 1520, S.maxEdge, S.maxTokens, 924, 1307],
    [1000, 1000, S.maxEdge, S.maxTokens, 1000, 1000],
    [1000, 1000, H.maxEdge, H.maxTokens, 1000, 1000],
  ];
  for (const [w, h, me, mt, ew, eh] of cases) {
    it(`${w}x${h} @(maxEdge=${me},maxTokens=${mt}) -> ${ew}x${eh}`, () => {
      assert.deepEqual(resizedSize(w, h, me, mt), { width: ew, height: eh });
    });
  }
  it('never exceeds edge or token limits', () => {
    for (const [w, h] of [
      [5000, 100],
      [100, 5000],
      [8000, 8000],
      [1568, 1569],
    ] as const) {
      const r = resizedSize(w, h, S.maxEdge, S.maxTokens);
      assert.ok(Math.ceil(r.width / 28) * 28 <= S.maxEdge, JSON.stringify(r));
      assert.ok(Math.ceil(r.height / 28) * 28 <= S.maxEdge, JSON.stringify(r));
      assert.ok(Math.ceil(r.width / 28) * Math.ceil(r.height / 28) <= S.maxTokens, JSON.stringify(r));
    }
  });
});

describe('tierFor', () => {
  it('selects high for claude >= 4.7', () => {
    assert.equal(tierFor('claude-opus-4-7-20260101', ''), TIER_HIGH);
    assert.equal(tierFor('claude-sonnet-5-0', ''), TIER_HIGH);
  });
  it('standard for older and non-claude ids', () => {
    assert.equal(tierFor('claude-opus-4-5', ''), TIER_STANDARD);
    assert.equal(tierFor('claude-3-7-sonnet-20250219', ''), TIER_STANDARD);
    assert.equal(tierFor('gpt-5', ''), TIER_STANDARD);
  });
  it('env override wins', () => {
    assert.equal(tierFor('claude-opus-4-5', 'high'), TIER_HIGH);
    assert.equal(tierFor('claude-opus-4-9', 'standard'), TIER_STANDARD);
  });
});

describe('AnthropicClient.next', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
  fs.writeFileSync(path.join(dir, 'ANTHROPIC_API_KEY'), 'k3y\n');

  it('sends schema request, parses first text block + usage', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchFn = async (url: unknown, init?: RequestInit) => {
      seen = { url: String(url), init: must(init) };
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{"action":{"kind":"CLICK","label":"go","ref":"e1"}}' }],
          usage: { input_tokens: 11, output_tokens: 7 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const c = new AnthropicClient({ model: 'claude-opus-4-7', secretsDir: dir, fetchFn: fetchFn as typeof fetch });
    const obs = { step_id: 's0001', url: 'http://x/', title: 't', screenshot: { png: Buffer.from('PNG'), width: 1920, height: 1080 } };
    const reply = await c.next({
      spec: { name: 't', start_url: '', goal: 'g', allowed_origins: [] } as never,
      observation: obs,
      history: [],
      schema: {},
    });
    assert.equal(must<{ url: string; init: RequestInit }>(seen).url, 'https://api.anthropic.com/v1/messages');
    const headers = must<{ url: string; init: RequestInit }>(seen).init.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], 'k3y');
    assert.equal(headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(String(must<{ url: string; init: RequestInit }>(seen).init.body));
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.equal(body.messages[0].content[0].type, 'image');
    assert.equal(body.messages[0].content[0].oversized_image, undefined);
    assert.equal(body.messages[0].content[1].type, 'text');
    assert.deepEqual(reply.usage, { input_tokens: 11, output_tokens: 7 });
    // raw is unnormalized here; normalizeEnums runs in the loop
    assert.equal((reply.raw as { action: { kind: string } }).action.kind, 'CLICK');
  });

  it('throws on API error and on missing text block', async () => {
    const bad = new AnthropicClient({
      model: 'claude-opus-4-7',
      secretsDir: dir,
      fetchFn: (async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 400 })) as typeof fetch,
    });
    await assert.rejects(
      () =>
        bad.next({
          spec: { name: 't', start_url: '', goal: 'g', allowed_origins: [] } as never,
          observation: {} as never,
          history: [],
          schema: {},
        }),
      /HTTP 400/,
    );
    const empty = new AnthropicClient({
      model: 'claude-opus-4-7',
      secretsDir: dir,
      fetchFn: (async () => new Response(JSON.stringify({ content: [] }), { status: 200 })) as typeof fetch,
    });
    await assert.rejects(
      () =>
        empty.next({
          spec: { name: 't', start_url: '', goal: 'g', allowed_origins: [] } as never,
          observation: {} as never,
          history: [],
          schema: {},
        }),
      /no text content block/,
    );
  });

  it('imageSize applies the tier', () => {
    const hi = new AnthropicClient({ model: 'claude-opus-4-9', secretsDir: dir, fetchFn: fetch });
    assert.deepEqual(hi.imageSize({ width: 3840, height: 2160 }), { width: 2576, height: 1449 });
    const lo = new AnthropicClient({ model: 'claude-opus-4-5', secretsDir: dir, fetchFn: fetch });
    assert.deepEqual(lo.imageSize({ width: 1920, height: 1080 }), { width: 1456, height: 819 });
  });
});
