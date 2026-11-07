#!/usr/bin/env bun
/**
 * SPEC §14 aggregate coverage gate.
 *
 * Bun's `coverageThreshold` in bunfig.toml is per-file and bun has no branch
 * metric, while §14's floors are aggregate (lines ≥90%, functions ≥90% on the
 * pure modules; IO modules are excluded because the acceptance suite covers
 * them). Bun also only instruments files a test actually loads, so the gate
 * additionally requires the report to contain exactly the expected sources —
 * otherwise deleting a module's tests would silently shrink the denominator.
 *
 * Branches are reported as n/a: bun does not instrument them.
 */
import fs from 'node:fs';
import { atLeast, CoverageError, evaluate, expectedSources, parseLcov, percent, readIgnorePatterns, sourceFiles } from './coverage.ts';

const LCOV = process.env.COVERAGE_LCOV ?? 'coverage/lcov.info';
const MIN_LINES = num('COVERAGE_MIN_LINES', 90);
const MIN_FUNCS = num('COVERAGE_MIN_FUNCS', 90);

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got '${raw}'`);
  return value;
}

const fail = (message: string): never => {
  console.error(`coverage-gate: FAILED — ${message}`);
  process.exit(1);
};

try {
  if (!fs.existsSync(LCOV)) fail(`${LCOV} not found — run \`bun run test:coverage\` first`);
  if (!fs.existsSync('bunfig.toml')) fail('bunfig.toml not found (it holds the coverage exclusions)');

  const patterns = readIgnorePatterns(fs.readFileSync('bunfig.toml', 'utf8'));
  const expected = expectedSources(sourceFiles(process.cwd()), patterns);
  if (expected.length === 0) fail('no expected sources after exclusions');

  const instrumented = parseLcov(fs.readFileSync(LCOV, 'utf8'));
  const { totals, missing, unexpected } = evaluate(instrumented, expected);

  if (missing.length > 0) fail(`not instrumented (no test loads them): ${missing.join(', ')}`);
  if (unexpected.length > 0) fail(`unexpected files in the report (not under src/ or not excluded): ${unexpected.join(', ')}`);

  const lines = percent(totals.linesHit, totals.lines);
  const funcs = percent(totals.funcsHit, totals.funcs);
  const below = [
    atLeast(totals.linesHit, totals.lines, MIN_LINES)
      ? ''
      : `lines ${totals.linesHit}/${totals.lines} (${lines.toFixed(2)}%) < ${MIN_LINES}%`,
    atLeast(totals.funcsHit, totals.funcs, MIN_FUNCS)
      ? ''
      : `functions ${totals.funcsHit}/${totals.funcs} (${funcs.toFixed(2)}%) < ${MIN_FUNCS}%`,
  ].filter(Boolean);

  console.log(
    `coverage-gate: ${expected.length} files, lines ${totals.linesHit}/${totals.lines} = ${lines.toFixed(2)}% (min ${MIN_LINES}%), ` +
      `functions ${totals.funcsHit}/${totals.funcs} = ${funcs.toFixed(2)}% (min ${MIN_FUNCS}%), branches n/a`,
  );
  if (below.length > 0) fail(below.join('; '));
} catch (error) {
  if (error instanceof CoverageError) fail(error.message);
  throw error;
}
