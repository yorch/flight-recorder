import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { EventLog, nowMs } from '../../src/events.ts';

describe('EventLog', () => {
  it('emits increasing seq and monotonic t_ms, refuses existing file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-'));
    const f = path.join(dir, 'events.jsonl');
    const log = new EventLog(f);
    log.emit({ type: 'RUN_START', run_id: 'r', test: 't', screen: { width: 1, height: 1 }, chrome_version: 'c', model: 'm' });
    log.emit({ type: 'THINKING_START', step_id: 's0001' });
    log.emit({ type: 'RUN_END', status: 'PASSED', summary: 's' });
    await log.close();
    const lines = fs
      .readFileSync(f, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      lines.map((l) => l.seq),
      [0, 1, 2],
    );
    assert.equal(lines[0].type, 'RUN_START');
    assert.ok(lines[1].t_ms >= lines[0].t_ms);
    assert.ok(Number.isFinite(nowMs()));
    // 'wx' flag: reopening the same file fails asynchronously on the stream
    const dup = new EventLog(f);
    const err: Error | null = await new Promise((res) => {
      (dup as unknown as { stream: { on: (e: string, cb: (err: Error) => void) => void } }).stream.on('error', (e) => res(e));
      setTimeout(() => res(null), 200);
    });
    assert.ok(err, 'expected wx open of existing file to error');
  });
});
