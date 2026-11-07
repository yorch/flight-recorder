import { afterAll, describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareArtifactDir } from '../../src/runner/manager.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-artifacts-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('prepareArtifactDir (§16.1)', () => {
  it('creates artifacts/<run_id> writable by the container node user', () => {
    const dir = prepareArtifactDir(root, '20261107-000000-aaaa');
    assert.equal(dir, path.join(root, 'artifacts', '20261107-000000-aaaa'));
    assert.ok(fs.statSync(dir).isDirectory());
    // The orchestrator runs as uid 1000; on Linux hosts the directory belongs to
    // a different uid, so it must be world-writable to accept the run output.
    assert.equal(fs.statSync(dir).mode & 0o777, 0o777);
  });

  it('is idempotent for a re-run of the same id', () => {
    prepareArtifactDir(root, '20261107-000000-bbbb');
    fs.chmodSync(path.join(root, 'artifacts', '20261107-000000-bbbb'), 0o755);
    assert.equal(fs.statSync(prepareArtifactDir(root, '20261107-000000-bbbb')).mode & 0o777, 0o777);
  });
});
