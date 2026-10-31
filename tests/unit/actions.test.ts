import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentTurn, agentTurnJsonSchema, agentWireSchema, normalizeEnums, toWireSchema } from '../../src/agent/actions.ts';

const FORBIDDEN = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'pattern',
  'format',
  '$schema',
  'oneOf',
]);

function walk(node: unknown, cb: (n: Record<string, unknown>) => void) {
  if (Array.isArray(node)) {
    node.forEach((x) => {
      walk(x, cb);
    });
    return;
  }
  if (node && typeof node === 'object') {
    cb(node as Record<string, unknown>);
    Object.values(node as Record<string, unknown>).forEach((v) => {
      walk(v, cb);
    });
  }
}

describe('toWireSchema', () => {
  const wire = toWireSchema(agentTurnJsonSchema) as Record<string, unknown>;

  it('has no forbidden keys, no oneOf, root is object', () => {
    walk(wire, (n) => {
      for (const k of Object.keys(n)) assert.ok(!FORBIDDEN.has(k), `forbidden key ${k}`);
    });
    assert.equal(wire.type, 'object');
  });

  it('every object with properties is strict: required=all keys, additionalProperties=false', () => {
    let seen = 0;
    walk(wire, (n) => {
      if (n.properties && typeof n.properties === 'object') {
        seen += 1;
        assert.deepEqual([...(n.required as string[])].sort(), Object.keys(n.properties as object).sort());
        assert.equal(n.additionalProperties, false);
      }
    });
    assert.ok(seen > 5, `expected >5 objects, saw ${seen}`);
  });

  it('converts oneOf to anyOf', () => {
    let sawAnyOf = 0;
    walk(wire, (n) => {
      if (n.anyOf) sawAnyOf += 1;
    });
    assert.ok(sawAnyOf >= 1);
  });

  it('does not mutate the source schema', () => {
    let oneOfCount = 0;
    walk(agentTurnJsonSchema, (n) => {
      if (n.oneOf) oneOfCount += 1;
    });
    assert.ok(oneOfCount >= 1);
  });
});

describe('agentWireSchema', () => {
  const plan = { steps: [{ id: 'p1' }, { id: 'p2' }], criteria: [{ id: 'c1' }, { id: 'c2' }] };
  type Branch = { properties: Record<string, Record<string, unknown>>; required: string[] };
  type TurnWire = {
    properties: { action: { anyOf: Branch[] }; label: unknown; plan_step: { enum: unknown[] } };
    required: string[];
  };

  it('hoists label and plan_step out of the action branches', () => {
    const w = agentWireSchema(plan) as TurnWire;
    assert.deepEqual(w.required, ['action', 'label', 'plan_step']);
    assert.deepEqual(w.properties.plan_step.enum, ['p1', 'p2']);
    for (const b of w.properties.action.anyOf) {
      assert.ok(!('label' in b.properties));
      assert.ok(!('plan_step' in b.properties));
      assert.deepEqual([...b.required].sort(), Object.keys(b.properties).sort());
    }
  });

  it('turns criterion into a plan-id enum plus null', () => {
    const w = agentWireSchema(plan) as TurnWire;
    const withCriterion = w.properties.action.anyOf.filter((b) => 'criterion' in b.properties);
    assert.ok(withCriterion.length === 4);
    for (const b of withCriterion) assert.deepEqual(b.properties.criterion.enum, ['c1', 'c2', null]);
  });

  it('without a plan, plan_step and criterion must be null', () => {
    const w = agentWireSchema() as TurnWire;
    assert.deepEqual(w.properties.plan_step.enum, [null]);
    for (const b of w.properties.action.anyOf.filter((b) => 'criterion' in b.properties)) {
      assert.deepEqual(b.properties.criterion.enum, [null]);
    }
  });

  it('stays under the provider union-parameter limit (16)', () => {
    const w = agentWireSchema(plan) as TurnWire;
    let unions = 0;
    walk(w, (n) => {
      if (n.anyOf) unions += 1;
      if (Array.isArray(n.type)) unions += 1;
    });
    assert.ok(unions <= 16, `union-typed parameters: ${unions}`);
  });
});

describe('AgentTurn validation', () => {
  it('accepts a valid click action', () => {
    const r = AgentTurn.safeParse({ action: { kind: 'click', plan_step: null, label: 'x', ref: 'e12' } });
    assert.ok(r.success);
  });
  it('accepts f-prefixed refs', () => {
    assert.ok(AgentTurn.safeParse({ action: { kind: 'click', plan_step: null, label: 'x', ref: 'f1e3' } }).success);
    assert.ok(!AgentTurn.safeParse({ action: { kind: 'click', plan_step: null, label: 'x', ref: 'div#x' } }).success);
  });
  it('rejects disallowed keys and invalid kinds', () => {
    assert.ok(!AgentTurn.safeParse({ action: { kind: 'press', plan_step: null, label: 'x', key: 'F4' } }).success);
    assert.ok(!AgentTurn.safeParse({ action: { kind: 'shutdown', plan_step: null, label: 'x' } }).success);
  });
  it('requires prompt_text key but allows null', () => {
    assert.ok(AgentTurn.safeParse({ action: { kind: 'dialog', plan_step: null, label: 'x', accept: true, prompt_text: null } }).success);
    assert.ok(AgentTurn.safeParse({ action: { kind: 'dialog', plan_step: null, label: 'x', accept: true, prompt_text: 'hi' } }).success);
    assert.ok(!AgentTurn.safeParse({ action: { kind: 'dialog', plan_step: null, label: 'x', accept: true } }).success);
  });
  it('rejects unknown properties (strictObject)', () => {
    assert.ok(!AgentTurn.safeParse({ action: { kind: 'click', plan_step: null, label: 'x', ref: 'e1', extra: 1 } }).success);
  });
});

describe('normalizeEnums', () => {
  it('maps case-insensitively onto known literals', () => {
    const raw = { action: { kind: 'CLICK', plan_step: null, label: 'x', ref: 'e1' } };
    const norm = normalizeEnums(raw) as { action: { kind: string } };
    assert.equal(norm.action.kind, 'click');
  });
  it('normalizes status/verdict/mode/key nested anywhere', () => {
    const norm = normalizeEnums({
      action: { kind: 'type', label: 'x', ref: 'e1', text: 't', mode: 'APPEND' },
      extra: [{ status: 'failed' }, { verdict: 'Passed' }, { key: 'arrowdown' }],
    }) as Record<string, unknown>;
    const a = norm.action as { mode: string };
    const x = norm.extra as Record<string, string>[];
    assert.equal(a.mode, 'append');
    assert.equal(x[0].status, 'FAILED');
    assert.equal(x[1].verdict, 'PASSED');
    assert.equal(x[2].key, 'ArrowDown');
  });
  it('leaves unknown values untouched', () => {
    const n = normalizeEnums({ action: { kind: 'weird', plan_step: null } }) as { action: { kind: string } };
    assert.equal(n.action.kind, 'weird');
  });
  it('leaves non-strings and arrays intact', () => {
    assert.deepEqual(normalizeEnums([1, 'x', null]), [1, 'x', null]);
  });
});
