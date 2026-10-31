import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { finishNudge } from '../../src/agent/loop.ts';

const criteria = [
  { id: 'c1', description: 'public page lists the post' },
  { id: 'c2', description: 'post shows the image' },
];

const passed = (criterion: string | null) => ({ criterion, passed: true });
const failed = (criterion: string | null) => ({ criterion, passed: false });

describe('finishNudge (§15.3)', () => {
  it('accepts when every criterion has a PASSED assertion naming it', () => {
    const r = finishNudge(criteria, [passed('c1'), passed('c2')], 0);
    assert.equal(r.decision, 'accept');
    assert.deepEqual(r.unproven, []);
  });

  it('nudges when a criterion lacks a passing assertion', () => {
    const r = finishNudge(criteria, [passed('c1')], 0);
    assert.equal(r.decision, 'nudge');
    assert.deepEqual(r.unproven, [{ id: 'c2', description: 'post shows the image' }]);
  });

  it('a FAILED assertion does not prove its criterion', () => {
    const r = finishNudge(criteria, [passed('c1'), failed('c2')], 0);
    assert.equal(r.decision, 'nudge');
    assert.deepEqual(
      r.unproven.map((c) => c.id),
      ['c2'],
    );
  });

  it('an assertion with criterion null proves nothing', () => {
    const r = finishNudge(criteria, [passed(null), passed('c1')], 0);
    assert.equal(r.decision, 'nudge');
    assert.deepEqual(
      r.unproven.map((c) => c.id),
      ['c2'],
    );
  });

  it('nudges at most twice, then accepts (run ends UNVERIFIED, §15.5)', () => {
    const only = [passed('c1')];
    assert.equal(finishNudge(criteria, only, 0).decision, 'nudge');
    assert.equal(finishNudge(criteria, only, 1).decision, 'nudge');
    assert.equal(finishNudge(criteria, only, 2).decision, 'accept');
    assert.equal(finishNudge(criteria, only, 3).decision, 'accept');
  });

  it('accepts with zero unproven regardless of nudge count', () => {
    assert.equal(finishNudge(criteria, [passed('c1'), passed('c2')], 5).decision, 'accept');
  });
});
