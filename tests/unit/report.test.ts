import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import type { Evaluation, Plan } from '../../src/agent/plan.ts';
import type { TestSpec } from '../../src/config.ts';
import { buildReportJson, escapeHtml, renderReportHtml } from '../../src/report/report.ts';

const plan: Plan = {
  title: 'x"><img onerror=alert(1)>',
  steps: [{ id: 'p1', intent: 'do <script>alert(1)</script>', expected: 'e' }],
  criteria: [{ id: 'c1', description: 'c' }],
};
const evaluation: Evaluation = {
  criteria: [{ id: 'c1', status: 'MET', evidence: 'ev <script>', screenshots: ['screenshots/final.png'] }],
  issues: [{ severity: 'high', title: '"><img onerror=alert(1)>', description: 'd', plan_step: 'p1', screenshot: null }],
  conclusions: 'All fine <script>alert(1)</script> "><img onerror=alert(1)> javascript:alert(1)',
};
const spec = { name: 't', start_url: 'http://app.test/x', goal: 'goal <script>', allowed_origins: ['http://app.test'] } as TestSpec;
const input = {
  run_id: 'r1',
  status: 'PASSED' as const,
  summary: 'sum',
  model: 'stub/x',
  chrome_version: '1',
  started_at: 'a',
  ended_at: 'b',
  tokens: { input: 1, output: 2 },
  egress: null,
  spec,
  plan,
  planStatus: { p1: 'PASSED' },
  stepNotes: {},
  stepDones: [{ plan_step: 'p1', status: 'PASSED' as const }],
  assertions: [{ step_id: 's1', label: 'l', criterion: 'c1', passed: true }],
  evaluation,
  chapters: [{ id: 's1', title: 'p1 · l', status: 'PASSED' as const, start: 1, end: 2, plan_step: 'p1' }],
  screenshots: [{ plan_step: 'p1', path: 'screenshots/s0001.png' }],
};

describe('report escaping (§15.6)', () => {
  const html = renderReportHtml(buildReportJson(input));
  it('escapes every interpolated value; no live markup survives', () => {
    assert.ok(!html.includes('<script'), 'raw <script leaked');
    for (const tag of html.match(/<img[^>]*>/g) ?? []) assert.ok(!tag.includes('onerror'), `live img tag: ${tag}`);
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('&lt;img onerror=alert(1)&gt;'));
    assert.ok(html.includes('&#39;') || html.includes('&quot;'));
  });
  it('links and embeds only relative artifact paths', () => {
    const hrefs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(hrefs.length > 0);
    for (const h of hrefs) {
      assert.ok(!h.includes('://') && !h.startsWith('javascript:') && !h.startsWith('/'), `bad link ${h}`);
    }
    assert.ok(hrefs.includes('final.mp4'));
    assert.ok(hrefs.includes('chapters.vtt'));
    assert.ok(hrefs.includes('screenshots/s0001.png'));
  });
  it('escapeHtml covers all five specials', () => {
    assert.equal(escapeHtml(`<a href="x">'&'`).replaceAll('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;', 'OK'), 'OK');
  });
  it('chapter start time lands in report.json plan steps', () => {
    const r = buildReportJson(input);
    assert.equal(r.plan?.steps[0].chapter_start, 1);
    assert.equal(r.plan?.steps[0].screenshots[0], 'screenshots/s0001.png');
    assert.equal(r.plan?.criteria[0].verified, true);
  });
});
