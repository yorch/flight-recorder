import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import type { EventInput, TimelineEvent } from '../../src/events.ts';
import { activeChapter, buildChapters, runStatusForChapters, toVtt } from '../../src/postprocess/chapters.ts';
import { chooseDuration } from '../../src/postprocess/duration.ts';
import { PARAMS } from '../../src/postprocess/params.ts';
import { buildTimeMap, mapTime, outputDuration, setptsExpr, subtract } from '../../src/postprocess/timemap.ts';
import { buildZoomWindows, zoomExprs } from '../../src/postprocess/zoom.ts';

const T0 = 1_000_000;
const ev = (t: number, rest: EventInput): TimelineEvent => ({ seq: 0, t_ms: T0 + t * 1000, ...rest }) as TimelineEvent;
const rel =
  (videoStart = T0) =>
  (ms: number) =>
    (ms - videoStart) / 1000;

const SCREEN = { width: 1920, height: 1080 };

const must = <T>(v: T | null | undefined): NonNullable<T> => {
  assert.ok(v != null, 'expected non-null value');
  return v;
};

describe('subtract', () => {
  it('cuts inner spans and keeps disjoint ones', () => {
    assert.deepEqual(subtract([[0, 10]], [[3, 5]]), [
      [0, 3],
      [5, 10],
    ]);
    assert.deepEqual(subtract([[0, 10]], [[-5, 20]]), []);
    assert.deepEqual(subtract([[0, 10]], [[10, 20]]), [[0, 10]]);
    assert.deepEqual(
      subtract(
        [
          [0, 4],
          [6, 10],
        ],
        [[2, 7]],
      ),
      [
        [0, 2],
        [7, 10],
      ],
    );
    assert.deepEqual(subtract([[0, 5]], []), [[0, 5]]);
  });
});

function scenario(): { events: TimelineEvent[]; r: (ms: number) => number } {
  const events: TimelineEvent[] = [
    ev(0, { type: 'RUN_START', run_id: 'r', test: 't', screen: SCREEN, chrome_version: 'x', model: 'm' }),
    ev(0.1, { type: 'RECORDING_START', file: 'raw.mkv', video_start_ms: T0 }),
    ev(2, { type: 'THINKING_START', step_id: 's0001' }),
    ev(10, { type: 'THINKING_END', step_id: 's0001' }),
    ev(10, { type: 'ACTION_START', step_id: 's0001', label: 'click', action: 'click', mode: 'ELEMENT' }),
    ev(10.2, { type: 'ACTION_TARGET', step_id: 's0001', point: { x: 100, y: 100 }, box: { x: 80, y: 80, width: 40, height: 40 } }),
    ev(11, { type: 'ACTION_END', step_id: 's0001', status: 'PASSED' }),
    ev(30, { type: 'ACTION_START', step_id: 's0002', label: 'coord', action: 'click', mode: 'COORDINATE' }),
    ev(30.1, { type: 'ACTION_TARGET', step_id: 's0002', point: { x: 900, y: 500 } }),
    ev(31, { type: 'ACTION_END', step_id: 's0002', status: 'FAILED', error: 'x' }),
    ev(40, { type: 'RECORDING_STOP' }),
    ev(40, { type: 'RUN_END', status: 'FAILED', summary: 's' }),
  ];
  return { events, r: rel(T0) };
}

describe('buildTimeMap', () => {
  const { events, r } = scenario();
  const segs = buildTimeMap(events, r, 40);

  it('produces contiguous segments covering 0..duration', () => {
    assert.equal(segs[0].inStart, 0);
    assert.equal(must(segs.at(-1)).inEnd, 40);
    for (let i = 1; i < segs.length; i++) assert.equal(segs[i].inStart, segs[i - 1].inEnd);
  });
  it('active windows get PRE_PAD/POST_PAD and speed 1', () => {
    // s0001 active ~[9.7,12], s0002 ~[29.7,32]
    const a1 = must(segs.find((s) => s.inStart === 9.7));
    const a2 = must(segs.find((s) => s.inStart === 29.7));
    assert.equal(a1.inEnd, 12);
    assert.equal(a1.speed, 1);
    assert.equal(a2.inEnd, 32);
  });
  it('idle speed formula: 1x under MIN_IDLE else max(IDLE_SPEED, gap/IDLE_MAX_OUT)', () => {
    const idle = segs.filter((s) => s.speed > 1);
    for (const s of idle) {
      const gap = s.inEnd - s.inStart;
      assert.ok(gap >= PARAMS.MIN_IDLE);
      assert.equal(s.speed, Math.max(PARAMS.IDLE_SPEED, gap / PARAMS.IDLE_MAX_OUT));
    }
  });
  it('ignores ACTION_START without ACTION_END for active windows', () => {
    const e2 = [...events, ev(35, { type: 'ACTION_START', step_id: 'sX', label: 'x', action: 'click', mode: 'ELEMENT' })];
    const s2 = buildTimeMap(e2, r, 40);
    const speed1 = s2.filter((s) => s.inStart >= 32 && s.inStart < 38 && s.speed === 1 && s.inEnd - s.inStart < 2);
    assert.equal(speed1.length, 0, 'orphan ACTION_START must not create an active window');
  });
  it('actions longer than ACTIVE_MAX keep ACTIVE_KEEP at both ends; middles compress', () => {
    const long: TimelineEvent[] = [
      ev(0, { type: 'ACTION_START', step_id: 'a', label: 'slow', action: 'navigate', mode: 'PAGE' }),
      ev(7, { type: 'ACTION_END', step_id: 'a', status: 'PASSED' }),
      ev(30, { type: 'ACTION_START', step_id: 'b', label: 'fast', action: 'navigate', mode: 'PAGE' }),
      ev(33, { type: 'ACTION_END', step_id: 'b', status: 'PASSED' }),
    ];
    const s3 = buildTimeMap(long, r, 40);
    const kept = s3.filter((x) => x.speed === 1 && x.inStart < 9);
    assert.deepEqual(
      kept.map((x) => [x.inStart, x.inEnd]),
      [
        [0, 1.5],
        [5.5, 8],
      ],
    );
    const mid = must(s3.find((x) => x.inStart === 1.5));
    assert.ok(mid.speed >= PARAMS.IDLE_SPEED);
    assert.ok((mid.inEnd - mid.inStart) / mid.speed <= PARAMS.IDLE_MAX_OUT);
    const b1 = must(s3.find((x) => x.inStart === 29.7));
    assert.equal(b1.speed, 1);
    assert.ok(Math.abs(b1.inEnd - 34) < 0.01);
  });
  it('typing-heavy runs are not compressed (short actions stay 1x)', () => {
    const typing: TimelineEvent[] = [
      ev(0, { type: 'ACTION_START', step_id: 't1', label: 't', action: 'type', mode: 'ELEMENT' }),
      ev(1.2, { type: 'ACTION_END', step_id: 't1', status: 'PASSED' }),
      ev(1.5, { type: 'ACTION_START', step_id: 't2', label: 't', action: 'type', mode: 'ELEMENT' }),
      ev(2.8, { type: 'ACTION_END', step_id: 't2', status: 'PASSED' }),
    ];
    const s4 = buildTimeMap(typing, r, 10);
    const act = s4.filter((x) => x.inEnd <= 3.8); // active windows only, not the idle tail
    assert.ok(act.length > 0 && act.every((x) => x.speed === 1));
  });
  it('mapTime is monotonic and correct at boundaries', () => {
    let prev = -1;
    for (let t = 0; t <= 40; t += 0.01) {
      const m = mapTime(segs, t);
      assert.ok(m >= prev - 1e-9, `non-monotonic at ${t}`);
      prev = m;
    }
    assert.equal(mapTime(segs, 0), 0);
    for (const s of segs) {
      assert.equal(mapTime(segs, s.inStart), s.outStart, `inStart ${s.inStart}`);
      const outEnd = s.outStart + (s.inEnd - s.inStart) / s.speed;
      assert.ok(Math.abs(mapTime(segs, s.inEnd - 1e-9) - outEnd) < 0.01);
    }
    assert.equal(mapTime(segs, 999), outputDuration(segs));
  });
  it('outputDuration sums compressed time', () => {
    const want = segs.reduce((a, s) => a + (s.inEnd - s.inStart) / s.speed, 0);
    assert.equal(outputDuration(segs), want);
    assert.ok(want < 40);
  });
});

describe('setptsExpr', () => {
  /** Tiny evaluator for "k*clip(T-a,0,b)+..." terms. */
  function evalExpr(expr: string, T: number): number {
    let sum = 0;
    for (const term of expr.split('+')) {
      const m = /^([\d.]+)\*clip\(T-([\d.]+),0,([\d.]+)\)$/.exec(term.trim());
      assert.ok(m, `bad term ${term}`);
      const [, k, a, b] = m;
      sum += Number(k) * Math.min(Math.max(T - Number(a), 0), Number(b));
    }
    return sum;
  }
  it('evaluates identically to mapTime at many T', () => {
    const { events, r } = scenario();
    const segs = buildTimeMap(events, r, 40);
    const expr = setptsExpr(segs);
    assert.match(expr, /clip\(T-0\.000/);
    for (let T = 0; T <= 40; T += 0.037) {
      // boundaries are emitted with ms precision, so allow one ms of slack
      assert.ok(Math.abs(evalExpr(expr, T) - mapTime(segs, T)) < 0.01, `T=${T} expr=${evalExpr(expr, T)} map=${mapTime(segs, T)}`);
    }
  });
  it('empty events still maps the full duration at 1x or idle', () => {
    const segs = buildTimeMap([], (r) => r, 10);
    const expr = setptsExpr(segs);
    assert.ok(evalExpr(expr, 5) >= 0);
  });
});

describe('duration parsing', () => {
  it('chooseDuration prefers format duration, falls back to last packet', () => {
    assert.equal(chooseDuration('12.34\n', ''), 12.34);
    assert.equal(chooseDuration('N/A\n', '0.1\n0.2\n9.876\n'), 9.876);
    assert.throws(() => chooseDuration('N/A\n', 'N/A\n'));
    assert.throws(() => chooseDuration('0\n', '-1\n'));
  });
});

describe('buildZoomWindows', () => {
  const { events, r } = scenario();
  const segs = buildTimeMap(events, r, 40);
  const wins = buildZoomWindows(events, segs, r, SCREEN);

  it('uses element box for ELEMENT mode and DEFAULT_TARGET for COORDINATE', () => {
    assert.equal(wins.length, 2);
    assert.deepEqual(wins[0].box, { x: 80, y: 80, width: 40, height: 40 });
    const w2 = wins[1].box;
    assert.equal(w2.width, PARAMS.DEFAULT_TARGET.width);
    assert.equal(w2.height, PARAMS.DEFAULT_TARGET.height);
    assert.equal(w2.x + w2.width / 2, 900);
    assert.equal(w2.y + w2.height / 2, 500);
  });
  it('window spans target->ACTION_END+ZOOM_HOLD in output time, start >= 0', () => {
    for (const w of wins) {
      assert.ok(w.start >= 0);
      assert.ok(w.end > w.start);
    }
    assert.ok(Math.abs(wins[0].start - (mapTime(segs, r(events[5].t_ms)) - PARAMS.ZOOM_RAMP)) < 1e-6);
  });
  it('merges windows closer than ZOOM_MERGE_GAP with union box', () => {
    const close: TimelineEvent[] = [
      ev(0, { type: 'ACTION_START', step_id: 'a', label: '1', action: 'click', mode: 'ELEMENT' }),
      ev(0.1, { type: 'ACTION_TARGET', step_id: 'a', point: { x: 0, y: 0 }, box: { x: 0, y: 0, width: 10, height: 10 } }),
      ev(0.5, { type: 'ACTION_END', step_id: 'a', status: 'PASSED' }),
      ev(1.0, { type: 'ACTION_START', step_id: 'b', label: '2', action: 'click', mode: 'ELEMENT' }),
      ev(1.1, { type: 'ACTION_TARGET', step_id: 'b', point: { x: 100, y: 100 }, box: { x: 100, y: 100, width: 10, height: 10 } }),
      ev(1.5, { type: 'ACTION_END', step_id: 'b', status: 'PASSED' }),
      ev(60, { type: 'ACTION_START', step_id: 'c', label: '3', action: 'click', mode: 'ELEMENT' }),
      ev(60.1, { type: 'ACTION_TARGET', step_id: 'c', point: { x: 500, y: 500 }, box: { x: 500, y: 500, width: 10, height: 10 } }),
      ev(60.5, { type: 'ACTION_END', step_id: 'c', status: 'PASSED' }),
    ];
    const segs2 = buildTimeMap(close, r, 60.5);
    const w2 = buildZoomWindows(close, segs2, r, SCREEN);
    assert.equal(w2.length, 2, JSON.stringify(w2));
    assert.deepEqual(w2[0].box, { x: 0, y: 0, width: 110, height: 110 });
  });
});

describe('zoomExprs', () => {
  it('returns identity for no windows', () => {
    assert.deepEqual(zoomExprs([], 1920, 1080), { z: '1', x: '0', y: '0' });
  });
  it('clamps zoom level to [1, ZOOM_MAX] and emits trapezoid weights', () => {
    const wins = buildZoomWindows(scenario().events, buildTimeMap(scenario().events, rel(T0), 40), rel(T0), SCREEN);
    const { z, x, y } = zoomExprs(wins, 1920, 1080);
    assert.match(z, /^1\+/);
    assert.match(z, /clip\(\(it-/);
    assert.match(z, /clip\(\(.*-it\)/);
    assert.match(x, /^clip\(/);
    assert.match(y, /^clip\(/);
    // tiny box 40x40: level = min(1920/(40*3),1080/(40*3))=9 -> clamped to 2
    assert.match(z, /1\.000\*clip/);
  });
  it('large box gives zoom ~1', () => {
    const w = [{ start: 1, end: 3, box: { x: 0, y: 0, width: 2000, height: 1100 } }];
    const { z } = zoomExprs(w, 1920, 1080);
    assert.match(z, /0\.000\*clip/);
  });
});

describe('chapters', () => {
  it('builds contiguous chapters starting at 0, folds action-less steps', () => {
    const { events, r } = scenario();
    const segs = buildTimeMap(events, r, 40);
    const ch = buildChapters(events, segs, r);
    assert.equal(ch.length, 2);
    assert.equal(ch[0].start, 0);
    assert.equal(ch[0].id, 's0001');
    assert.equal(ch[0].status, 'PASSED');
    assert.equal(ch[1].status, 'FAILED');
    for (let i = 1; i < ch.length; i++) assert.equal(ch[i].start, ch[i - 1].end);
    assert.equal(must(ch.at(-1)).end, outputDuration(segs));
  });
  it('VTT format HH:MM:SS.mmm and title sanitized', () => {
    const vtt = toVtt([
      { id: 's0000', title: 'a --> b', status: 'PASSED', start: 0, end: 2.15 },
      { id: 's0001', title: 'x', status: 'FAILED', start: 2.15, end: 14.9 },
    ]);
    assert.match(vtt, /^WEBVTT\n\n/);
    assert.match(vtt, /00:00:00\.000 --> 00:00:02\.150/);
    assert.match(vtt, /a -> b \(PASSED\)/);
    assert.ok(!vtt.includes('a --> b ('));
    assert.match(vtt, /00:00:02\.150 --> 00:00:14\.900/);
  });
  it('activeChapter returns the last started chapter', () => {
    const ch = [
      { id: 'a', title: 'a', status: 'PASSED' as const, start: 0, end: 2 },
      { id: 'b', title: 'b', status: 'PASSED' as const, start: 2, end: 5 },
    ];
    assert.equal(activeChapter(ch, -1), null);
    assert.equal(must(activeChapter(ch, 0)).id, 'a');
    assert.equal(must(activeChapter(ch, 4.9)).id, 'b');
  });
});

describe('segments/setpts robustness', () => {
  it('handles empty event list and zero freezes', () => {
    const segs = buildTimeMap([], (x) => x / 1000, 3);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].inStart, 0);
    assert.equal(segs[0].inEnd, 3);
    assert.equal(segs[0].speed, Math.max(PARAMS.IDLE_SPEED, 3 / PARAMS.IDLE_MAX_OUT));
  });
});

describe('runStatusForChapters', () => {
  it('uses RUN_END status when present and FAILED when the run was truncated', () => {
    assert.equal(runStatusForChapters({ status: 'PASSED' }), 'PASSED');
    assert.equal(runStatusForChapters({ status: 'UNVERIFIED' }), 'UNVERIFIED');
    assert.equal(runStatusForChapters(undefined), 'FAILED');
  });
});
