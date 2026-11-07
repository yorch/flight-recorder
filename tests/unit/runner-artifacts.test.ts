import { afterAll, describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareArtifactRoot } from '../../src/runner/manager.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-artifacts-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('prepareArtifactRoot (§16.1)', () => {
  it('creates the artifacts root writable by the container node user', () => {
    const dir = prepareArtifactRoot(root);
    assert.equal(dir, path.join(root, 'artifacts'));
    assert.ok(fs.statSync(dir).isDirectory());
    // The orchestrator runs as uid 1000 and creates its own run directory.
    assert.equal(fs.statSync(dir).mode & 0o777, 0o777);
  });

  it('does not pre-create the run directory, so §9 stays true', () => {
    prepareArtifactRoot(root);
    assert.equal(fs.existsSync(path.join(root, 'artifacts', '20261107-000000-aaaa')), false);
  });

  it('is idempotent and re-applies the mode', () => {
    prepareArtifactRoot(root);
    fs.chmodSync(path.join(root, 'artifacts'), 0o755);
    assert.equal(fs.statSync(prepareArtifactRoot(root)).mode & 0o777, 0o777);
  });
});
