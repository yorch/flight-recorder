/**
 * Pure helpers for the SPEC §14 coverage gate. The CLI lives in
 * `scripts/coverage-gate.ts`; keeping the parsing here makes it unit-testable
 * without spawning bun.
 */
import fs from 'node:fs';
import path from 'node:path';

export class CoverageError extends Error {}

export interface Totals {
  lines: number;
  linesHit: number;
  funcs: number;
  funcsHit: number;
}

const COUNTERS = ['LF', 'LH', 'FNF', 'FNH'] as const;
type Counter = (typeof COUNTERS)[number];

const counter = (raw: string | undefined, key: string, file: string): number => {
  if (raw === undefined || !/^\d+$/.test(raw)) throw new CoverageError(`lcov: bad ${key} counter in ${file}: '${raw ?? ''}'`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new CoverageError(`lcov: ${key} counter out of range in ${file}`);
  return value;
};

/** One lcov record: summary counters must agree with the per-line (`DA`) detail. */
interface LcovRecord {
  file: string;
  counters: Partial<Record<Counter, number>>;
  lines: Map<number, number>;
  fnNames: Set<string>;
  fnHits: Set<string>;
  sawFn: boolean;
  sawFnDa: boolean;
}

const finalize = (r: LcovRecord): Totals => {
  for (const key of COUNTERS) {
    if (r.counters[key] === undefined) throw new CoverageError(`lcov: ${r.file} is missing ${key}`);
  }
  const totals: Totals = {
    lines: r.counters.LF as number,
    linesHit: r.counters.LH as number,
    funcs: r.counters.FNF as number,
    funcsHit: r.counters.FNH as number,
  };
  if (totals.lines === 0) throw new CoverageError(`lcov: ${r.file} reports no executable lines`);
  const hitLines = [...r.lines.values()].filter((hits) => hits > 0).length;
  if (totals.lines !== r.lines.size) {
    throw new CoverageError(`lcov: ${r.file} claims LF:${totals.lines} but lists ${r.lines.size} DA entries`);
  }
  if (totals.linesHit !== hitLines) {
    throw new CoverageError(`lcov: ${r.file} claims LH:${totals.linesHit} but ${hitLines} DA entries are covered`);
  }
  if (r.sawFn && totals.funcs !== r.fnNames.size) {
    throw new CoverageError(`lcov: ${r.file} claims FNF:${totals.funcs} but lists ${r.fnNames.size} distinct FN entries`);
  }
  if (r.sawFnDa && totals.funcsHit !== r.fnHits.size) {
    throw new CoverageError(`lcov: ${r.file} claims FNH:${totals.funcsHit} but ${r.fnHits.size} distinct FNDA entries are covered`);
  }
  if (totals.linesHit > totals.lines) throw new CoverageError(`lcov: ${r.file} has ${totals.linesHit} hit lines of ${totals.lines}`);
  if (totals.funcsHit > totals.funcs) throw new CoverageError(`lcov: ${r.file} has ${totals.funcsHit} hit functions of ${totals.funcs}`);
  return totals;
};

/**
 * Parses an lcov report into per-file totals, failing on anything it cannot read
 * exactly: unknown structure, unterminated or duplicate records, repeated
 * counters or line entries, non-integer or overflowing counts, summary counters
 * that disagree with the per-line detail, records with no executable lines, and
 * empty reports. A malformed or truncated report must never read as 100%.
 */
export function parseLcov(text: string): Map<string, Totals> {
  const out = new Map<string, Totals>();
  let current: LcovRecord | null = null;

  for (const line of text.split('\n')) {
    const trimmed = line.replace(/^\uFEFF/, '').trim();
    if (!trimmed) continue;

    if (trimmed === 'end_of_record') {
      if (current === null) throw new CoverageError('lcov: end_of_record outside a record');
      out.set(current.file, finalize(current));
      current = null;
      continue;
    }

    const sep = trimmed.indexOf(':');
    if (sep < 0) throw new CoverageError(`lcov: malformed line '${trimmed}'`);
    const key = trimmed.slice(0, sep);
    const value = trimmed.slice(sep + 1);

    if (key === 'SF') {
      if (current !== null) throw new CoverageError(`lcov: record for ${current.file} is not terminated`);
      if (out.has(value)) throw new CoverageError(`lcov: duplicate record for ${value}`);
      current = { file: value, counters: {}, lines: new Map(), fnNames: new Set(), fnHits: new Set(), sawFn: false, sawFnDa: false };
      continue;
    }
    if (current === null) {
      if (key === 'LF' || key === 'LH' || key === 'FNF' || key === 'FNH') throw new CoverageError(`lcov: ${key} outside a record`);
      continue;
    }

    if (key === 'DA') {
      const [lineNo, hits] = value.split(',');
      const at = counter(lineNo, 'DA line', current.file);
      const count = counter(hits, 'DA hits', current.file);
      if (current.lines.has(at)) throw new CoverageError(`lcov: duplicate DA line ${at} in ${current.file}`);
      current.lines.set(at, count);
      continue;
    }
    if (key === 'FN') {
      const name = value.slice(value.indexOf(',') + 1);
      if (!name) throw new CoverageError(`lcov: FN without a name in ${current.file}`);
      if (current.fnNames.has(name)) throw new CoverageError(`lcov: duplicate FN ${name} in ${current.file}`);
      current.sawFn = true;
      current.fnNames.add(name);
      continue;
    }
    if (key === 'FNDA') {
      const [hitsRaw, ...rest] = value.split(',');
      const name = rest.join(',');
      if (!name) throw new CoverageError(`lcov: FNDA without a name in ${current.file}`);
      if (current.fnNames.size > 0 && !current.fnNames.has(name)) {
        throw new CoverageError(`lcov: FNDA for unknown function ${name} in ${current.file}`);
      }
      if (current.fnHits.has(name)) throw new CoverageError(`lcov: duplicate FNDA ${name} in ${current.file}`);
      current.sawFnDa = true;
      const hits = counter(hitsRaw, 'FNDA hits', current.file);
      if (hits > 0) current.fnHits.add(name);
      else current.fnHits.delete(name);
      continue;
    }
    if (key !== 'LF' && key !== 'LH' && key !== 'FNF' && key !== 'FNH') continue; // TN/BRDA/...
    if (current.counters[key] !== undefined) throw new CoverageError(`lcov: duplicate ${key} in ${current.file}`);
    current.counters[key] = counter(value, key, current.file);
  }

  if (current !== null) throw new CoverageError(`lcov: record for ${current.file} is not terminated`);
  if (out.size === 0) throw new CoverageError('lcov: no source records');
  return out;
}

/**
 * Reads `test.coveragePathIgnorePatterns` from bunfig.toml with Bun's real TOML
 * parser (reached through globalThis so the Node-typed sources need no Bun
 * ambient types, and @types/bun's global augmentations stay out).
 */
export function readIgnorePatterns(bunfig: string): string[] {
  const runtime = (globalThis as { Bun?: { TOML?: { parse?: (text: string) => unknown } } }).Bun;
  const parseToml = runtime?.TOML?.parse;
  if (!parseToml) throw new CoverageError('bunfig.toml: reading the exclusions needs the bun runtime');
  let parsed: unknown;
  try {
    parsed = parseToml(bunfig);
  } catch (error) {
    throw new CoverageError(`bunfig.toml: invalid TOML (${(error as Error).message})`);
  }
  const test = (parsed as { test?: { coveragePathIgnorePatterns?: unknown } } | null)?.test;
  const patterns = test?.coveragePathIgnorePatterns;
  if (patterns === undefined) throw new CoverageError('bunfig.toml: test.coveragePathIgnorePatterns not found');
  if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== 'string')) {
    throw new CoverageError('bunfig.toml: test.coveragePathIgnorePatterns must be an array of strings');
  }
  if (patterns.length === 0) throw new CoverageError('bunfig.toml: test.coveragePathIgnorePatterns is empty');
  return patterns as string[];
}

/** Glob to regex with path semantics: `*` and `?` stay in one segment, `**` crosses them. */
const globToRegExp = (pattern: string): RegExp => {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
};

/** Matches a repo-relative POSIX path against a pattern. */
export function matchesPattern(file: string, pattern: string): boolean {
  return globToRegExp(pattern).test(file);
}

const comparePath = (a: string, b: string): number => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

const SOURCE_DIRS = ['src', 'scripts'] as const;

/** Every TypeScript source under `src/` and `scripts/`, repo-relative. */
export function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.ts')) found.push(child);
    }
  };
  for (const dir of SOURCE_DIRS) if (fs.existsSync(path.join(root, dir))) walk(dir);
  return found.sort(comparePath);
}

/** The files the report is required to contain: all sources minus the configured exclusions. */
export function expectedSources(files: string[], patterns: string[]): string[] {
  return files.filter((f) => !patterns.some((p) => matchesPattern(f, p))).sort(comparePath);
}

export interface Evaluation {
  totals: Totals;
  missing: string[];
  unexpected: string[];
}

/** Totals over the instrumented set, plus any drift between expected and reported files. */
export function evaluate(instrumented: Map<string, Totals>, expected: string[]): Evaluation {
  const totals: Totals = { lines: 0, linesHit: 0, funcs: 0, funcsHit: 0 };
  for (const t of instrumented.values()) {
    totals.lines += t.lines;
    totals.linesHit += t.linesHit;
    totals.funcs += t.funcs;
    totals.funcsHit += t.funcsHit;
  }
  if (![totals.lines, totals.linesHit, totals.funcs, totals.funcsHit].every((n) => Number.isSafeInteger(n))) {
    throw new CoverageError('coverage totals exceed the safe integer range');
  }
  const expectedSet = new Set(expected);
  const missing = expected.filter((f) => !instrumented.has(f));
  const unexpected = [...instrumented.keys()].filter((f) => !expectedSet.has(f)).sort(comparePath);
  return { totals, missing, unexpected };
}

/** Display only: exact comparisons must use `atLeast`. */
export const percent = (hit: number, total: number): number => (total === 0 ? 100 : (100 * hit) / total);

/**
 * `hit/total >= minPct` in exact integer arithmetic: float division rounds, and
 * `8106479329266891/9007199254740991` displays as 90.00% while being below 90%.
 */
export function atLeast(hit: number, total: number, minPct: number): boolean {
  if (!Number.isFinite(minPct) || minPct < 0) throw new CoverageError(`threshold must be a non-negative number, got ${minPct}`);
  if (!/^\d+(\.\d+)?$/.test(String(minPct))) {
    throw new CoverageError(`threshold must be a plain decimal (exponent notation is not supported), got ${minPct}`);
  }
  if (total <= 0) return true;
  const [whole, fraction = ''] = String(minPct).split('.');
  const scale = 10n ** BigInt(fraction.length);
  const minScaled = BigInt(whole) * scale + BigInt(fraction || '0');
  return BigInt(hit) * 100n * scale >= minScaled * BigInt(total);
}
