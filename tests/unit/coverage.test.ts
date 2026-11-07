import { afterAll, describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  atLeast,
  CoverageError,
  evaluate,
  expectedSources,
  matchesPattern,
  parseLcov,
  percent,
  readIgnorePatterns,
  sourceFiles,
} from '../../scripts/coverage.ts';

/** A consistent lcov record: summary counters agree with the per-line DA detail. */
const record = (file: string, lf: number, lh: number, fnf: number, fnh: number): string => {
  const das = Array.from({ length: lf }, (_, i) => `DA:${i + 1},${i < lh ? 1 : 0}`).join('\n');
  return `SF:${file}\nFNF:${fnf}\nFNH:${fnh}\n${das ? `${das}\n` : ''}LF:${lf}\nLH:${lh}\nend_of_record`;
};

describe('parseLcov', () => {
  it('aggregates complete records', () => {
    const files = parseLcov(`${record('src/a.ts', 10, 9, 2, 2)}\n${record('src/b.ts', 5, 1, 2, 0)}\n`);
    assert.equal(files.size, 2);
    assert.deepEqual(files.get('src/a.ts'), { lines: 10, linesHit: 9, funcs: 2, funcsHit: 2 });
    assert.deepEqual(files.get('src/b.ts'), { lines: 5, linesHit: 1, funcs: 2, funcsHit: 0 });
  });
  it('tolerates TN, BRDA and CRLF and a BOM', () => {
    const withDetail = record('src/a.ts', 2, 1, 1, 1).replace('LF:2', 'BRDA:1,0,0,1\nBRDA:2,0,1,\nLF:2');
    const text = `\uFEFFTN:\r\n${withDetail.replace(/\n/g, '\r\n')}\r\n`;
    assert.deepEqual(parseLcov(text).get('src/a.ts'), { lines: 2, linesHit: 1, funcs: 1, funcsHit: 1 });
  });
  it('rejects an empty report instead of reporting 100%', () => {
    assert.throws(() => parseLcov(''), CoverageError);
    assert.throws(() => parseLcov('\n\n'), CoverageError);
  });
  it('rejects records missing counters', () => {
    assert.throws(() => parseLcov('SF:src/a.ts\nLF:10\nLH:9\nFNF:1\nend_of_record'), /missing FNH/);
    assert.throws(() => parseLcov('SF:src/a.ts\nend_of_record'), /missing LF/);
  });
  it('rejects malformed, negative, fractional and overflowing counters', () => {
    assert.throws(() => parseLcov('SF:src/a.ts\nFNF:1\nFNH:1\nLF:ten\nLH:9\nend_of_record'), /bad LF counter/);
    assert.throws(() => parseLcov('SF:src/a.ts\nFNF:1\nFNH:1\nLF:-1\nLH:0\nend_of_record'), /bad LF counter/);
    assert.throws(() => parseLcov('SF:src/a.ts\nFNF:1\nFNH:1\nLF:1.5\nLH:1\nend_of_record'), /bad LF counter/);
    const huge = '9'.repeat(400);
    assert.throws(() => parseLcov(`SF:src/a.ts\nFNF:1\nFNH:1\nDA:1,1\nLF:${huge}\nLH:1\nend_of_record`), /out of range/);
  });
  it('rejects a summary that disagrees with the per-line detail', () => {
    // The only recorded line is uncovered, yet LH claims one hit.
    assert.throws(() => parseLcov('SF:src/a.ts\nFNF:0\nFNH:0\nDA:1,0\nLF:1\nLH:1\nend_of_record'), /DA entries are covered/);
    // LF disagrees with the number of DA entries.
    assert.throws(() => parseLcov('SF:src/a.ts\nFNF:0\nFNH:0\nDA:1,1\nLF:2\nLH:1\nend_of_record'), /lists 1 DA entries/);
    // FNH disagrees with the (distinct) FNDA detail when the report carries it.
    assert.throws(
      () => parseLcov('SF:src/a.ts\nFN:1,f\nFNDA:0,f\nFNF:1\nFNH:1\nDA:1,1\nLF:1\nLH:1\nend_of_record'),
      /FNDA entries are covered/,
    );
    // Duplicate FNDA entries cannot stand in for two different functions.
    assert.throws(
      () => parseLcov('SF:src/a.ts\nFN:1,f\nFN:2,g\nFNDA:1,f\nFNDA:1,f\nFNF:2\nFNH:2\nDA:1,1\nLF:1\nLH:1\nend_of_record'),
      /duplicate FNDA f/,
    );
    // FNDA for a function the record never declared.
    assert.throws(
      () => parseLcov('SF:src/a.ts\nFN:1,f\nFNDA:1,ghost\nFNF:1\nFNH:1\nDA:1,1\nLF:1\nLH:1\nend_of_record'),
      /unknown function ghost/,
    );
  });
  it('rejects duplicate line entries and duplicate records', () => {
    assert.throws(() => parseLcov('SF:src/a.ts\nFNF:0\nFNH:0\nDA:1,1\nDA:1,0\nLF:1\nLH:1\nend_of_record'), /duplicate DA line/);
    assert.throws(() => parseLcov(`${record('src/a.ts', 1, 1, 0, 0)}\n${record('src/a.ts', 1, 1, 0, 0)}`), /duplicate record/);
  });
  it('rejects counters outside a record and malformed lines', () => {
    assert.throws(() => parseLcov('LF:1\nLH:1\n'), /outside a record/);
    assert.throws(() => parseLcov('garbage line'), /malformed line/);
    assert.throws(() => parseLcov('end_of_record'), /outside a record/);
  });
  it('accepts a zero-function record', () => {
    const files = parseLcov(record('src/types.ts', 3, 3, 0, 0));
    assert.deepEqual(files.get('src/types.ts'), { lines: 3, linesHit: 3, funcs: 0, funcsHit: 0 });
  });
});

describe('parseLcov guardrails', () => {
  it('rejects a record with no executable lines', () => {
    assert.throws(() => parseLcov(record('src/empty.ts', 0, 0, 0, 0)), /no executable lines/);
  });
  it('rejects an unterminated record at EOF', () => {
    assert.throws(() => parseLcov('SF:src/a.ts\nLF:1\nLH:1\nFNF:1\nFNH:1'), /not terminated/);
  });
  it('rejects a record opened before the previous one ends', () => {
    assert.throws(
      () => parseLcov(`${record('src/a.ts', 1, 1, 0, 0).replace('end_of_record', '')}${record('src/b.ts', 1, 1, 0, 0)}`),
      /src\/a\.ts is not terminated/,
    );
  });
  it('rejects a repeated counter', () => {
    assert.throws(() => parseLcov('SF:src/a.ts\nLF:1\nLF:2\nLH:1\nFNF:1\nFNH:1\nend_of_record'), /duplicate LF/);
  });
});

describe('readIgnorePatterns', () => {
  it('reads the array with Bun TOML semantics', () => {
    const text = '[test]\ncoveragePathIgnorePatterns = [\n  \'src/main.ts\',\n  "src/agent/loop.ts",\n]\n';
    assert.deepEqual(readIgnorePatterns(text), ['src/main.ts', 'src/agent/loop.ts']);
  });
  it('ignores a commented-out assignment before the real one', () => {
    const text = "# coveragePathIgnorePatterns = ['src/**']\n[test]\ncoveragePathIgnorePatterns = ['src/main.ts']";
    assert.deepEqual(readIgnorePatterns(text), ['src/main.ts']);
  });
  it('keeps a bracketed comment inside the active array from breaking it', () => {
    const text = "[test]\ncoveragePathIgnorePatterns = [\n  'src/main.ts', # see [docs]\n]\n";
    assert.deepEqual(readIgnorePatterns(text), ['src/main.ts']);
  });
  it('rejects missing, empty, non-string and invalid TOML', () => {
    assert.throws(() => readIgnorePatterns('[test]\n'), /not found/);
    assert.throws(() => readIgnorePatterns('[test]\ncoveragePathIgnorePatterns = []\n'), /empty/);
    assert.throws(() => readIgnorePatterns('[test]\ncoveragePathIgnorePatterns = 1\n'), /array of strings/);
    assert.throws(() => readIgnorePatterns('not = [valid'), /invalid TOML/);
  });
});

describe('matchesPattern / expectedSources', () => {
  it('matches exact paths and single-star globs', () => {
    assert.equal(matchesPattern('src/main.ts', 'src/main.ts'), true);
    assert.equal(matchesPattern('src/main.ts', 'src/m.ts'), false);
    assert.equal(matchesPattern('src/agent/loop.ts', 'src/agent/*.ts'), true);
    assert.equal(matchesPattern('src/render.ts', 'src/*.ts'), true);
    assert.equal(matchesPattern('ui/src/app.ts', 'src/*.ts'), false);
    assert.equal(matchesPattern('src/a+b.ts', 'src/a+b.ts'), true, 'regex metacharacters are literal');
  });
  it('follows path glob semantics: * and ? stay in one segment, ** crosses', () => {
    assert.equal(matchesPattern('src/agent/a.ts', 'src/*.ts'), false);
    assert.equal(matchesPattern('src/main.ts', 'src/**/*.ts'), true);
    assert.equal(matchesPattern('src/agent/deep/a.ts', 'src/**/*.ts'), true);
    assert.equal(matchesPattern('src/a.ts', 'src/?.ts'), true);
    assert.equal(matchesPattern('src/ab.ts', 'src/?.ts'), false);
  });
  it('subtracts the exclusions and sorts', () => {
    const files = ['src/b.ts', 'src/a.ts', 'src/agent/loop.ts'];
    assert.deepEqual(expectedSources(files, ['src/agent/loop.ts']), ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(expectedSources(files, ['src/agent/*.ts']), ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(expectedSources(files, ['src/**/*.ts']), []);
  });
});

describe('sourceFiles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-'));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  it('walks src and scripts recursively and keeps only .ts files', () => {
    fs.mkdirSync(path.join(root, 'src/agent'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    for (const f of ['src/main.ts', 'src/agent/plan.ts', 'src/readme.md', 'scripts/gate.ts', 'scripts/run.sh']) {
      fs.writeFileSync(path.join(root, f), '');
    }
    assert.deepEqual(sourceFiles(root), ['scripts/gate.ts', 'src/agent/plan.ts', 'src/main.ts']);
  });
});

describe('evaluate', () => {
  const a = { lines: 10, linesHit: 9, funcs: 2, funcsHit: 1 };
  const b = { lines: 10, linesHit: 10, funcs: 2, funcsHit: 2 };
  it('sums totals and reports drift both ways', () => {
    const result = evaluate(new Map([['src/a.ts', a]]), ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(result.totals, { lines: 10, linesHit: 9, funcs: 2, funcsHit: 1 });
    assert.deepEqual(result.missing, ['src/b.ts']);
    assert.deepEqual(result.unexpected, []);
    const extra = evaluate(
      new Map([
        ['src/a.ts', a],
        ['src/c.ts', b],
      ]),
      ['src/a.ts'],
    );
    assert.deepEqual(extra.unexpected, ['src/c.ts']);
    assert.deepEqual(extra.totals, { lines: 20, linesHit: 19, funcs: 4, funcsHit: 3 });
  });
  it('rejects totals beyond the safe integer range', () => {
    const big = { lines: Number.MAX_SAFE_INTEGER, linesHit: 1, funcs: 1, funcsHit: 1 };
    assert.throws(
      () =>
        evaluate(
          new Map([
            ['src/a.ts', big],
            ['src/b.ts', big],
          ]),
          ['src/a.ts', 'src/b.ts'],
        ),
      /safe integer/,
    );
  });
});

describe('percent / atLeast', () => {
  it('percent is display-only and treats an empty denominator as complete', () => {
    assert.equal(percent(9, 10), 90);
    assert.equal(percent(0, 0), 100);
  });
  it('atLeast compares exactly at the boundary', () => {
    assert.equal(atLeast(9, 10, 90), true);
    assert.equal(atLeast(90, 100, 90), true);
    assert.equal(atLeast(8999, 10000, 90), false);
    assert.equal(atLeast(999, 1000, 99.9), true);
    assert.equal(atLeast(998, 1000, 99.9), false);
    assert.equal(atLeast(99, 100, 99.9), false);
    assert.equal(atLeast(0, 0, 90), true, 'no executable lines cannot fail here; parseLcov rejects that report');
  });
  it('atLeast does not round a just-below ratio up to the threshold', () => {
    // percent() displays 90.00 for this pair, but it is strictly below 90%.
    assert.equal(percent(8106479329266891, 9007199254740991).toFixed(2), '90.00');
    assert.equal(atLeast(8106479329266891, 9007199254740991, 90), false);
    assert.equal(atLeast(9007199254740991, 9007199254740991, 100), true);
  });
  it('atLeast rejects a negative threshold and exponent notation', () => {
    assert.throws(() => atLeast(1, 2, -1), /non-negative/);
    assert.throws(() => atLeast(1, 2, 1e-7), /plain decimal/);
  });
});
