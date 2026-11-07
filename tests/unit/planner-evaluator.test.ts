import { afterAll, describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelClient, ModelReply, StructuredInput } from '../../src/agent/contract.ts';
import { createModel } from '../../src/agent/model.ts';
import { evaluatorUserText, plannerUserText, runEvaluator, runPlanner } from '../../src/agent/planner.ts';
import type { Config, TestSpec } from '../../src/config.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-'));
// createModel builds real provider clients, which read their key at construction.
fs.writeFileSync(path.join(dir, 'ANTHROPIC_API_KEY'), 'akey\n');
fs.writeFileSync(path.join(dir, 'OPENAI_API_KEY'), 'okey\n');
process.env.SECRETS_DIR = dir;
afterAll(() => {
  process.env.SECRETS_DIR = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

const spec = {
  name: 't',
  start_url: 'http://app.test/',
  goal: 'publish a post',
  allowed_origins: [],
  assets: ['hero.png'],
  secrets: { user_email: { label: 'Email', input_type: 'email' }, user_password: { label: 'Password', input_type: 'password' } },
} as unknown as TestSpec;

const fake = (raw: unknown): ModelClient & { seen: StructuredInput[] } => {
  const seen: StructuredInput[] = [];
  return {
    id: 'fake/x',
    seen,
    imageSize: (s) => s,
    next: async () => ({ raw: null, usage: { input_tokens: 0, output_tokens: 0 } }),
    structured: async (input: StructuredInput): Promise<ModelReply> => {
      seen.push(input);
      return { raw, usage: { input_tokens: 0, output_tokens: 0 } };
    },
  } as ModelClient & { seen: StructuredInput[] };
};

const plan = {
  title: 'Publish',
  steps: [{ id: 'p1', intent: 'open admin', expected: 'admin open' }],
  criteria: [{ id: 'c1', description: 'post visible' }],
};

describe('plannerUserText (§15.2)', () => {
  it('carries instructions, url, assets and secret placeholders only', () => {
    assert.equal(
      plannerUserText(spec),
      [
        'Instructions: publish a post',
        'Start URL: http://app.test/',
        'Available files: hero.png',
        'Available secrets: {{secret:user_email}}, {{secret:user_password}}',
      ].join('\n'),
    );
  });
  it('says none when there are no assets or secrets', () => {
    const bare = { ...spec, assets: undefined, secrets: undefined } as unknown as TestSpec;
    assert.match(plannerUserText(bare), /Available files: none/);
    assert.match(plannerUserText(bare), /Available secrets: none/);
  });
});

describe('runPlanner', () => {
  it('validates and returns the plan from the agent_plan call', async () => {
    const model = fake(plan);
    const out = await runPlanner(model, spec);
    assert.deepEqual(out, plan);
    assert.equal(model.seen.length, 1);
    assert.equal(model.seen[0].name, 'agent_plan');
  });
  it('returns null when the provider signals no plan', async () => {
    assert.equal(await runPlanner(fake(null), spec), null);
  });
  it('rejects an invalid plan', async () => {
    await assert.rejects(() => runPlanner(fake({ title: 'x', steps: [], criteria: [] }), spec));
  });
});

describe('evaluatorUserText (§15.4)', () => {
  it('labels every section and lists plan steps and criteria', () => {
    const text = evaluatorUserText({
      spec,
      plan,
      stepLog: 's0000 click ok',
      assertions: 'c1 assert_url passed',
      summary: 'done',
      screenshots: [{ name: 'final.png', png: Buffer.from('x') }],
    });
    assert.match(text, /^Instructions: publish a post$/m);
    assert.match(text, /^Plan: Publish$/m);
    assert.match(text, /^- p1 open admin \(expected: admin open\)$/m);
    assert.match(text, /^- c1 post visible$/m);
    assert.match(text, /^Step log:\ns0000 click ok$/m);
    assert.match(text, /^Assertions:\nc1 assert_url passed$/m);
    assert.match(text, /^Agent summary: done$/m);
    assert.match(text, /^Screenshots: final\.png$/m);
  });
  it('marks empty sections explicitly', () => {
    const text = evaluatorUserText({ spec, plan, stepLog: '', assertions: '', summary: '', screenshots: [] });
    assert.match(text, /\(no actions recorded\)/);
    assert.match(text, /Assertions:\n\(none\)/);
    assert.match(text, /Screenshots: none/);
  });
});

describe('runEvaluator', () => {
  const evaluation = { criteria: [{ id: 'c1', status: 'MET', evidence: 'e', screenshots: [] }], issues: [], conclusions: 'ok' };
  it('sends at most 8 screenshots as image parts', async () => {
    const model = fake(evaluation);
    const shots = Array.from({ length: 10 }, (_, i) => ({ name: `s${i}.png`, png: Buffer.from('x') }));
    const out = await runEvaluator(model, { spec, plan, stepLog: '', assertions: '', summary: '', screenshots: shots });
    assert.deepEqual(out, evaluation);
    const parts = model.seen[0].parts ?? [];
    assert.equal(parts.filter((p) => p.type === 'image').length, 8);
    assert.equal(model.seen[0].name, 'agent_eval');
  });
  it('rejects an invalid evaluation', async () => {
    await assert.rejects(() =>
      runEvaluator(fake({ criteria: [{ id: 'c1', status: 'MAYBE' }] }), {
        spec,
        plan,
        stepLog: '',
        assertions: '',
        summary: '',
        screenshots: [],
      }),
    );
  });
});

describe('createModel (§6.7)', () => {
  const cfg = (provider: string) => ({ provider, model: 'm', screen: { width: 1920, height: 1080 } }) as unknown as Config;
  it('maps each provider to its client', () => {
    assert.equal(createModel(cfg('anthropic')).id, 'anthropic/m');
    assert.equal(createModel(cfg('openai')).id, 'openai/m');
    const script = path.join(dir, 'stub.json');
    fs.writeFileSync(script, JSON.stringify({ turns: [] }));
    assert.equal(createModel({ ...(cfg('stub') as object), model: script } as Config).id, `stub/${script}`);
  });
  it('rejects an unknown provider', () => {
    assert.throws(() => createModel(cfg('ollama')), /Unknown AGENT_MODEL provider: ollama/);
  });
});
