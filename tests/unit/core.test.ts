import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Budget, BudgetExceeded } from '../../src/agent/budget.ts';
import { imageToScreen } from '../../src/agent/coords.ts';
import { StubClient } from '../../src/agent/providers/stub.ts';
import { computeVerdict, exitCode } from '../../src/agent/verdict.ts';
import { isAllowedOrigin, loadConfig, parseTestSpec } from '../../src/config.ts';
import { parseAccessLogLine, summarizeAccessLog, targetHostPort } from '../../src/egress.ts';
import { clampToScreen } from '../../src/geometry.ts';
import { _resetSecrets, loadSecrets, redact, resolvePlaceholders, SecretBindingError } from '../../src/secrets.ts';

const SCREEN = { width: 1920, height: 1080 };

const must = <T>(v: T | null | undefined): NonNullable<T> => {
  assert.ok(v != null, 'expected non-null value');
  return v;
};

describe('computeVerdict (§6.4 table)', () => {
  const rows: [Parameters<typeof computeVerdict>[0], ReturnType<typeof computeVerdict>][] = [
    [{ claimed: 'FAILED', assertionFailed: false, expectResults: null, harnessError: false, budgetExceeded: false }, 'FAILED'],
    [{ claimed: 'FAILED', assertionFailed: true, expectResults: [true], harnessError: false, budgetExceeded: false }, 'FAILED'],
    [{ claimed: 'PASSED', assertionFailed: true, expectResults: [true], harnessError: false, budgetExceeded: false }, 'FAILED'],
    [{ claimed: 'PASSED', assertionFailed: false, expectResults: [true, true], harnessError: false, budgetExceeded: false }, 'PASSED'],
    [{ claimed: 'PASSED', assertionFailed: false, expectResults: [true, false], harnessError: false, budgetExceeded: false }, 'FAILED'],
    [{ claimed: 'PASSED', assertionFailed: false, expectResults: null, harnessError: false, budgetExceeded: false }, 'UNVERIFIED'],
    [{ claimed: 'PASSED', assertionFailed: false, expectResults: [], harnessError: false, budgetExceeded: false }, 'PASSED'],
    [{ claimed: 'PASSED', assertionFailed: false, expectResults: [true], harnessError: true, budgetExceeded: false }, 'FAILED'],
    [{ claimed: 'PASSED', assertionFailed: false, expectResults: [true], harnessError: false, budgetExceeded: true }, 'FAILED'],
  ];
  rows.forEach(([input, want], i) => {
    it(`row ${i} -> ${want}`, () => assert.equal(computeVerdict(input), want));
  });
});

describe('exitCode (§6.6)', () => {
  it('maps statuses', () => {
    assert.equal(exitCode('PASSED', false), 0);
    assert.equal(exitCode('FAILED', false), 1);
    assert.equal(exitCode('UNVERIFIED', false), 3);
  });
  it('harness error wins', () => assert.equal(exitCode('PASSED', true), 2));
});

describe('Budget', () => {
  it('throws when wall clock exceeds timeout_s', () => {
    let t = 1000;
    const b = new Budget({ timeout_s: 1, now: () => t });
    b.check();
    t += 1001;
    assert.throws(() => b.check(), BudgetExceeded);
  });
  it('throws when tokens exceed max_model_tokens', () => {
    const b = new Budget({ max_model_tokens: 10, now: () => 0 });
    b.addTokens({ input_tokens: 6, output_tokens: 4 });
    b.check();
    b.addTokens({ input_tokens: 1, output_tokens: 0 });
    assert.throws(() => b.check(), BudgetExceeded);
    assert.equal(b.totalTokens, 11);
  });
  it('applies spec defaults', () => {
    const b = new Budget({ now: () => 0 });
    b.addTokens({ input_tokens: 499_999, output_tokens: 1 });
    b.check();
  });
});

describe('clampToScreen / imageToScreen', () => {
  it('clamps and rounds', () => {
    assert.deepEqual(clampToScreen({ x: -5, y: 2000.4 }, SCREEN), { x: 0, y: 1079 });
    assert.deepEqual(clampToScreen({ x: 5000, y: -1 }, SCREEN), { x: 1919, y: 0 });
  });
  it('rejects non-finite', () => {
    assert.throws(() => clampToScreen({ x: NaN, y: 0 }, SCREEN));
    assert.throws(() => clampToScreen({ x: 0, y: Infinity }, SCREEN));
  });
  it('imageToScreen maps and clamps', () => {
    const img = { width: 1456, height: 819 };
    assert.deepEqual(imageToScreen({ x: 1456, y: 819 }, img, SCREEN), { x: 1919, y: 1079 });
    assert.deepEqual(imageToScreen({ x: 728, y: 410 }, img, SCREEN), { x: 960, y: 541 });
    assert.deepEqual(imageToScreen({ x: -10, y: 5000 }, img, SCREEN), { x: 0, y: 1079 });
    assert.deepEqual(imageToScreen({ x: 0, y: 0 }, img, SCREEN), { x: 0, y: 0 });
  });
});

describe('secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-'));
  fs.writeFileSync(path.join(dir, 'PASS'), 'hunter2\n');
  fs.writeFileSync(path.join(dir, 'MAIL'), 'a@b.c');
  const spec = parseTestSpec({
    name: 't',
    start_url: 'http://x/',
    goal: 'g',
    allowed_origins: ['http://x'],
    secrets: {
      PASS: { origins: ['http://x'], input_types: ['password'] },
      MAIL: { origins: ['http://x', 'http://y'], input_types: ['email', 'text'] },
    },
  });

  it('loads values and redacts longest-first', () => {
    loadSecrets(['PASS', 'MAIL'], dir);
    assert.equal(redact('the pw is hunter2 and mail a@b.c'), 'the pw is {{secret:PASS}} and mail {{secret:MAIL}}');
  });
  it('resolves placeholders when binding matches', () => {
    loadSecrets(['PASS', 'MAIL'], dir);
    assert.equal(resolvePlaceholders('pw={{secret:PASS}}', spec, { origin: 'http://x', inputType: 'password' }), 'pw=hunter2');
    assert.equal(resolvePlaceholders('m={{secret:MAIL}}', spec, { origin: 'http://y', inputType: 'email' }), 'm=a@b.c');
    assert.throws(
      () => resolvePlaceholders('{{secret:MAIL}} and {{secret:PASS}}', spec, { origin: 'http://x', inputType: 'password' }),
      SecretBindingError,
    );
  });
  it('throws on undeclared name, wrong origin, wrong input type', () => {
    loadSecrets(['PASS', 'MAIL'], dir);
    assert.throws(() => resolvePlaceholders('{{secret:NOPE}}', spec, { origin: 'http://x', inputType: 'password' }), SecretBindingError);
    assert.throws(() => resolvePlaceholders('{{secret:PASS}}', spec, { origin: 'http://evil', inputType: 'password' }), SecretBindingError);
    assert.throws(() => resolvePlaceholders('{{secret:PASS}}', spec, { origin: 'http://x', inputType: 'text' }), SecretBindingError);
    assert.throws(() => resolvePlaceholders('{{secret:MAIL}}', spec, { origin: 'http://x', inputType: 'password' }), SecretBindingError);
    assert.throws(() => resolvePlaceholders('{{secret:GONE}}', spec, { origin: 'http://x', inputType: 'text' }), SecretBindingError);
  });
  it('missing file throws', () => {
    assert.throws(() => loadSecrets(['MISSING'], dir), SecretBindingError);
  });
  it('redact is a no-op with empty registry', () => {
    _resetSecrets();
    assert.equal(redact('hunter2'), 'hunter2');
  });
});

describe('config', () => {
  const base = { name: 't', start_url: 'http://x/', goal: 'g', allowed_origins: ['http://x:8080'] };
  it('accepts valid origins and hosts, rejects invalid', () => {
    assert.doesNotThrow(() => parseTestSpec({ ...base, allowed_hosts: ['*.cdn.test:8080', 'h.test', '*.x.io'] }));
    assert.throws(() => parseTestSpec({ ...base, allowed_origins: ['not a url'] }));
    assert.throws(() => parseTestSpec({ ...base, allowed_origins: ['http://x:8080/path'] }));
    assert.throws(() => parseTestSpec({ ...base, allowed_hosts: ['bad host!', 'ok.test'] }));
    assert.throws(() => parseTestSpec({ ...base, allowed_hosts: ['a..b'] }));
    assert.throws(() => parseTestSpec({ ...base, allowed_origins: ['ftp://x'] }));
    assert.throws(() => parseTestSpec({ ...base, allowed_hosts: ['h:999999'] }));
  });
  it('isAllowedOrigin matches exact origin only', () => {
    const spec = parseTestSpec({ ...base, allowed_origins: ['https://a.b:8443', 'http://x'] });
    assert.ok(isAllowedOrigin('https://a.b:8443/deep/path?q=1', spec));
    assert.ok(isAllowedOrigin('http://x/y', spec));
    assert.ok(!isAllowedOrigin('https://a.b/other', spec));
    assert.ok(!isAllowedOrigin('https://evil.a.b:8443/', spec));
    assert.ok(!isAllowedOrigin('chrome://sandbox', spec));
    assert.ok(!isAllowedOrigin('not a url', spec));
  });
  it('loadConfig reads env and parses AGENT_MODEL', () => {
    const c = loadConfig({ RUN_ID: 'r1', TEST_FILE: '/t.json', AGENT_MODEL: 'anthropic/claude-opus-4-7' } as NodeJS.ProcessEnv);
    assert.equal(c.provider, 'anthropic');
    assert.equal(c.model, 'claude-opus-4-7');
    assert.deepEqual(c.screen, { width: 1920, height: 1080 });
    assert.equal(c.cdpUrl, 'http://127.0.0.1:9222');
  });
  it('loadConfig requires env vars and a provider slash', () => {
    assert.throws(() => loadConfig({} as NodeJS.ProcessEnv), /RUN_ID|TEST_FILE|AGENT_MODEL/);
    assert.throws(() => loadConfig({ RUN_ID: 'r', TEST_FILE: 't', AGENT_MODEL: 'noslash' } as NodeJS.ProcessEnv), /provider/);
  });
});

describe('egress', () => {
  const LINES = [
    '1793369340.412 172.19.0.3 172.19.0.2:3128 GET http://proxy:3129/? 403 TCP_DENIED',
    '1793369340.421 172.19.0.3 172.19.0.2:3128 GET http://evil.test:8080/img.png? 403 TCP_DENIED',
    '1793369340.421 172.19.0.3 172.19.0.2:3128 GET http://allowed.test:8081/img.png? 403 TCP_DENIED',
    '1793369340.422 172.19.0.3 172.19.0.2:3128 GET http://a.cdn.test:8080/img.png? 200 TCP_MISS',
    '1793369340.426 172.19.0.3 172.19.0.2:3128 CONNECT allowed.test:8080 200 TCP_TUNNEL',
    '1793369345.445 172.19.0.3 172.19.0.2:3128 GET http://evil.test:8080/ 403 TCP_DENIED',
    '1793369345.477 172.19.0.3 172.19.0.2:3129 GET http://llm.test:8080/agent? 200 TCP_MISS',
    '1793369489.295 172.18.0.3 172.18.0.2:3128 CONNECT example.com:443 200 TCP_TUNNEL',
    '1793369489.371 172.18.0.3 172.18.0.2:3128 CONNECT example.org:443 403 TCP_DENIED_ABORTED',
    '1793369346.195 172.19.0.3 172.19.0.2:3128 CONNECT update.googleapis.com:443 403 TCP_DENIED',
  ].join('\n');

  it('parses a log line', () => {
    const e = must(parseAccessLogLine(LINES.split('\n')[0]));
    assert.equal(e.method, 'GET');
    assert.equal(e.url, 'http://proxy:3129/?');
    assert.equal(e.status, 403);
    assert.equal(e.result, 'TCP_DENIED');
    assert.equal(parseAccessLogLine('garbage'), null);
  });
  it('targetHostPort handles CONNECT and URL forms', () => {
    const [connect, http] = [must(parseAccessLogLine(LINES.split('\n')[4])), must(parseAccessLogLine(LINES.split('\n')[1]))];
    assert.equal(targetHostPort(connect), 'allowed.test:8080');
    assert.equal(targetHostPort(http), 'evil.test:8080');
    const https = { ...connect, url: 'https://h.test/x' };
    assert.equal(targetHostPort(https), 'h.test:443');
    const dflt = { ...connect, url: 'http://h.test/x' };
    assert.equal(targetHostPort(dflt), 'h.test:80');
    const bad = { ...connect, url: 'http://[' };
    assert.equal(targetHostPort(bad), 'http://[');
  });
  it('summarizes allowed and denied grouped by host', () => {
    const s = summarizeAccessLog(LINES);
    assert.equal(s.allowed, 4);
    assert.deepEqual(s.denied, [
      { host: 'evil.test:8080', count: 2 },
      { host: 'allowed.test:8081', count: 1 },
      { host: 'example.org:443', count: 1 },
      { host: 'proxy:3129', count: 1 },
      { host: 'update.googleapis.com:443', count: 1 },
    ]);
  });
});

describe('StubClient', () => {
  it('returns turns in order, repeats done when exhausted, honors sleep and image_size', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-'));
    const file = path.join(dir, 's.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        image_size: { width: 100, height: 50 },
        turns: [
          { action: { kind: 'click', plan_step: null, label: 'a', ref: 'e1' }, sleep_ms: 1 },
          { action: { kind: 'done', status: 'FAILED', summary: 'end' } },
        ],
      }),
    );
    const c = new StubClient({ scriptPath: file, screen: SCREEN });
    assert.deepEqual(c.imageSize(SCREEN), { width: 100, height: 50 });
    const input = { spec: {} as never, observation: {} as never, history: [], schema: {} };
    const r1 = await c.next(input);
    assert.equal((r1.raw as { action: { kind: string } }).action.kind, 'click');
    const r2 = await c.next(input);
    assert.equal((r2.raw as { action: { status: string } }).action.status, 'FAILED');
    const r3 = await c.next(input);
    assert.equal((r3.raw as { action: { summary: string } }).action.summary, 'end');
    assert.deepEqual(r3.usage, { input_tokens: 0, output_tokens: 0 });
    fs.writeFileSync(path.join(dir, 'e.json'), JSON.stringify({ turns: [] }));
    const c2 = new StubClient({ scriptPath: path.join(dir, 'e.json'), screen: SCREEN });
    assert.deepEqual(c2.imageSize(SCREEN), SCREEN);
    const r4 = await c2.next(input);
    assert.equal((r4.raw as { action: { kind: string } }).action.kind, 'done');
  });
});
