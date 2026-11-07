import { afterAll, describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TIER_HIGH, TIER_STANDARD } from '../../src/agent/providers/anthropic.ts';
import { StubClient } from '../../src/agent/providers/stub.ts';

const SCREEN = { width: 1920, height: 1080 };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-provider-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

let n = 0;
const client = (script: unknown, screen = SCREEN): StubClient => {
  const file = path.join(dir, `s${n++}.json`);
  fs.writeFileSync(file, JSON.stringify(script));
  return new StubClient({ scriptPath: file, screen });
};

const patches = (s: { width: number; height: number }) => Math.ceil(s.width / 28) * Math.ceil(s.height / 28);
const input = { spec: {} as never, observation: {} as never, history: [], schema: {} };

describe('StubClient.imageSize', () => {
  it('script image_size wins', () => {
    assert.deepEqual(client({ turns: [], image_size: { width: 640, height: 360 } }).imageSize(SCREEN), { width: 640, height: 360 });
  });
  it('anthropic:standard fits the standard tier', () => {
    const size = client({ turns: [], image_size_from: 'anthropic:standard' }).imageSize(SCREEN);
    assert.ok(size.width <= TIER_STANDARD.maxEdge && size.height <= TIER_STANDARD.maxEdge);
    assert.ok(patches(size) <= TIER_STANDARD.maxTokens);
  });
  it('anthropic:high sends a 1920x1080 screen unchanged', () => {
    assert.deepEqual(client({ turns: [], image_size_from: 'anthropic:high' }).imageSize(SCREEN), SCREEN);
    assert.ok(patches(SCREEN) <= TIER_HIGH.maxTokens);
  });
  it('openai applies the OpenAI limiter', () => {
    const size = client({ turns: [], image_size_from: 'openai' }).imageSize({ width: 8000, height: 4000 });
    assert.ok(size.width <= 6000 && size.height <= 6000, JSON.stringify(size));
    assert.ok(Math.ceil(size.width / 32) * Math.ceil(size.height / 32) <= 10000, JSON.stringify(size));
  });
  it('defaults to the screen size', () => {
    assert.deepEqual(client({ turns: [] }).imageSize(SCREEN), SCREEN);
  });
});

describe('StubClient.structured', () => {
  it('synthesises a plan from the turns plan_step/criterion ids', async () => {
    const c = client({
      turns: [
        { action: { kind: 'click', ref: 'e1', plan_step: 'p2', criterion: 'c1' } },
        { action: { kind: 'assert_url', matches: 'x', plan_step: 'p1', criterion: 'c2' } },
        { action: { kind: 'click', ref: 'e2', plan_step: 'p2' } },
      ],
    });
    const plan = (await c.structured({ name: 'agent_plan', schema: {} } as never)).raw as {
      steps: { id: string }[];
      criteria: { id: string }[];
    };
    assert.deepEqual(
      plan.steps.map((s) => s.id),
      ['p2', 'p1'],
    );
    assert.deepEqual(
      plan.criteria.map((s) => s.id),
      ['c1', 'c2'],
    );
  });
  it('returns null for a legacy script without plan ids', async () => {
    const c = client({ turns: [{ action: { kind: 'click', ref: 'e1' } }] });
    assert.equal((await c.structured({ name: 'agent_plan', schema: {} } as never)).raw, null);
  });
  it('script plan is returned verbatim', async () => {
    const plan = { title: 't', steps: [{ id: 'p1', intent: 'i', expected: 'e' }], criteria: [{ id: 'c1', description: 'd' }] };
    const c = client({ turns: [{ action: { kind: 'click', ref: 'e1', plan_step: 'p1' } }], plan });
    assert.deepEqual((await c.structured({ name: 'agent_plan', schema: {} } as never)).raw, plan);
  });
  it('default evaluation marks the plan criteria MET', async () => {
    const c = client({
      turns: [{ action: { kind: 'click', ref: 'e1', plan_step: 'p1', criterion: 'c1' } }],
      plan: { title: 't', steps: [{ id: 'p1', intent: 'i', expected: 'e' }], criteria: [{ id: 'c9', description: 'd' }] },
    });
    const ev = (await c.structured({ name: 'agent_eval', schema: {} } as never)).raw as {
      criteria: { id: string; status: string }[];
      issues: unknown[];
    };
    assert.deepEqual(ev.criteria, [{ id: 'c9', status: 'MET', evidence: 'stub evidence', screenshots: [] }]);
    assert.deepEqual(ev.issues, []);
  });
  it('script evaluation is returned verbatim', async () => {
    const evaluation = { criteria: [], issues: [], conclusions: 'c' };
    assert.deepEqual((await client({ turns: [], evaluation }).structured({ name: 'agent_eval', schema: {} } as never)).raw, evaluation);
  });
  it('rejects an unknown structured call', async () => {
    await assert.rejects(
      () => client({ turns: [] }).structured({ name: 'agent_other', schema: {} } as never),
      /no response for structured call/,
    );
  });
});

describe('StubClient.next', () => {
  it('defaults plan_step/criterion to null so the loop can fill them in', async () => {
    const c = client({ turns: [{ action: { kind: 'assert_url', matches: 'x' } }] });
    const action = ((await c.next(input)).raw as { action: Record<string, unknown> }).action;
    assert.equal(action.plan_step, null);
    assert.equal(action.criterion, null);
  });
  it('maps point_from_screen into the image space', async () => {
    const c = client({
      turns: [{ action: { kind: 'click_at', point_from_screen: { x: 960, y: 540 } } }],
      image_size_from: 'anthropic:standard',
    });
    const img = c.imageSize(SCREEN);
    const action = ((await c.next(input)).raw as { action: Record<string, unknown> }).action;
    assert.equal(action.x, Math.round((960 * img.width) / SCREEN.width));
    assert.equal(action.y, Math.round((540 * img.height) / SCREEN.height));
    assert.equal('point_from_screen' in action, false);
  });
  it('returns done for an empty script', async () => {
    const last = (await client({ turns: [] }).next(input)).raw as { action: { kind: string; summary: string } };
    assert.equal(last.action.kind, 'done');
    assert.equal(last.action.summary, 'script exhausted');
  });
  it('repeats the last turn when the script runs out', async () => {
    const c = client({ turns: [{ action: { kind: 'wait', ms: 1 } }] });
    await c.next(input);
    assert.equal(((await c.next(input)).raw as { action: { kind: string } }).action.kind, 'wait');
  });
});
