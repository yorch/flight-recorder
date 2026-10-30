import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentTurn, agentTurnJsonSchema, normalizeEnums, toWireSchema } from '../../src/agent/actions.ts';

const FORBIDDEN = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
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
      if (n.anyOf && !n.oneOf) oneOfCount -= 100;
    });
    assert.ok(oneOfCount >= 1);
  });
});

describe('AgentTurn validation', () => {
  it('accepts a valid click action', () => {
    const r = AgentTurn.safeParse({ action: { kind: 'click', label: 'x', ref: 'e12' } });
    assert.ok(r.success);
  });
  it('accepts f-prefixed refs', () => {
    assert.ok(AgentTurn.safeParse({ action: { kind: 'click', label: 'x', ref: 'f1e3' } }).success);
    assert.ok(!AgentTurn.safeParse({ action: { kind: 'click', label: 'x', ref: 'div#x' } }).success);
  });
  it('rejects disallowed keys and invalid kinds', () => {
    assert.ok(!AgentTurn.safeParse({ action: { kind: 'press', label: 'x', key: 'F4' } }).success);
    assert.ok(!AgentTurn.safeParse({ action: { kind: 'shutdown', label: 'x' } }).success);
  });
  it('requires prompt_text key but allows null', () => {
    assert.ok(AgentTurn.safeParse({ action: { kind: 'dialog', label: 'x', accept: true, prompt_text: null } }).success);
    assert.ok(AgentTurn.safeParse({ action: { kind: 'dialog', label: 'x', accept: true, prompt_text: 'hi' } }).success);
    assert.ok(!AgentTurn.safeParse({ action: { kind: 'dialog', label: 'x', accept: true } }).success);
  });
  it('rejects unknown properties (strictObject)', () => {
    assert.ok(!AgentTurn.safeParse({ action: { kind: 'click', label: 'x', ref: 'e1', extra: 1 } }).success);
  });
});

describe('normalizeEnums', () => {
  it('maps case-insensitively onto known literals', () => {
    const raw = { action: { kind: 'CLICK', label: 'x', ref: 'e1' } };
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
    const n = normalizeEnums({ action: { kind: 'weird' } }) as { action: { kind: string } };
    assert.equal(n.action.kind, 'weird');
  });
  it('leaves non-strings and arrays intact', () => {
    assert.deepEqual(normalizeEnums([1, 'x', null]), [1, 'x', null]);
  });
});
