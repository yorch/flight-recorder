// Criterion 32 driver (§16.4): opens the detail page of a RUNNING stub run and
// asserts the §16.3 live-progress view fills in over SSE without a reload —
// phase, per-plan-step statuses, the agent step log, counters, the latest
// screenshot and the event timeline.
// Runs inside docker/e2e; same loopback relay as ui-e2e.mjs so the page origin
// stays 127.0.0.1:7070 and satisfies the Host/Origin guards.
// Usage: docker run --rm --add-host host.docker.internal:host-gateway \
//   -e E2E_RUN_ID=<id> --entrypoint node flight-recorder-e2e /e2e/live-progress-e2e.mjs
// Prints progress lines and a final `E2E_RESULT {json}`; exit 0 on pass.

import net from 'node:net';
import { chromium } from 'playwright';

const UPSTREAM = process.env.UI_UPSTREAM ?? 'host.docker.internal:7070';
const BASE = process.env.UI_BASE ?? 'http://127.0.0.1:7070';
const RUN_ID = process.env.E2E_RUN_ID ?? '';
const RELAY_PORT = Number(new URL(BASE).port || 80);

const ev = { runId: RUN_ID };
const step = (msg) => console.log(`[e2e] ${msg}`);
const fail = (msg) => {
  ev.error = msg;
  console.log(`E2E_RESULT ${JSON.stringify({ ...ev, ok: false })}`);
  process.exit(1);
};

if (!RUN_ID) fail('E2E_RUN_ID is required');

// --- loopback relay (identical to ui-e2e.mjs) ---
const [upHost, upPort] = UPSTREAM.split(':');
const relay = net.createServer((c) => {
  const u = net.createConnection(Number(upPort), upHost);
  c.pipe(u).pipe(c);
  c.on('error', () => {});
  u.on('error', () => {});
});
await new Promise((res, rej) => {
  relay.once('error', rej);
  relay.listen(RELAY_PORT, '127.0.0.1', res);
});
step(`relay 127.0.0.1:${RELAY_PORT} -> ${UPSTREAM}`);

let browser;
try {
  browser = await chromium.launch({ args: ['--no-sandbox'] });
} catch (err) {
  fail(`chromium launch: ${err}`);
}
const page = await (await browser.newContext()).newPage();
page.setDefaultTimeout(30000);
const text = async (sel) =>
  (
    await page
      .locator(sel)
      .first()
      .textContent()
      .catch(() => '')
  )?.trim() ?? '';

try {
  step(`open #/run/${RUN_ID}`);
  await page.goto(`${BASE}/#/run/${RUN_ID}`, { waitUntil: 'domcontentloaded' });

  // Live progress panel appears while the run is non-terminal.
  await page.waitForSelector('[data-testid="live-progress"]', { timeout: 120000 });
  ev.phaseSeen = await text('[data-testid="live-phase"]');

  // Rolling agent step log: rows carry step id, kind, label, result — and the
  // list grows without a page reload (SSE-driven).
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="step-log"] tbody tr').length >= 2, null, {
    timeout: 180000,
  });
  ev.stepLogRows1 = await page.locator('[data-testid="step-log"] tbody tr').count();
  ev.firstStepCells = await page.locator('[data-testid="step-log"] tbody tr').first().locator('td').allTextContents();
  const deadline = Date.now() + 90000;
  for (;;) {
    await page.waitForTimeout(1000);
    ev.stepLogRows2 = await page.locator('[data-testid="step-log"] tbody tr').count();
    if (ev.stepLogRows2 > ev.stepLogRows1 || Date.now() > deadline) break;
  }
  ev.stepLogGrew = ev.stepLogRows2 > ev.stepLogRows1;

  // Counters: elapsed, steps, model tokens.
  ev.counterElapsed = await text('[data-testid="counter-elapsed"]');
  ev.counterSteps = await text('[data-testid="counter-steps"]');
  ev.counterTokens = await text('[data-testid="counter-tokens"]');
  ev.counters = { elapsed: ev.counterElapsed, steps: ev.counterSteps, tokens: ev.counterTokens };

  // Per-plan-step statuses.
  ev.planStepStatuses = await page.locator('[data-testid="plan-step-statuses"] li').count();

  // Latest observation screenshot loads and refreshes.
  await page.waitForSelector('[data-testid="live-shot"] img', { timeout: 180000 });
  ev.shotSrc = await page.getAttribute('[data-testid="live-shot"] img', 'src');
  await page
    .waitForFunction(
      () => {
        const i = document.querySelector('[data-testid="live-shot"] img');
        return i?.complete && i.naturalWidth > 0;
      },
      null,
      { timeout: 60000 },
    )
    .catch(() => {});
  ev.shotLoaded = await page.$eval('[data-testid="live-shot"] img', (i) => i.complete && i.naturalWidth > 0).catch(() => false);

  // Compact event timeline.
  ev.timelineRows = await page.locator('[data-testid="timeline"] tbody tr').count();
} catch (err) {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
}

const ok =
  ev.stepLogRows1 >= 2 &&
  (ev.firstStepCells ?? []).length >= 4 &&
  ev.stepLogGrew === true &&
  /^\d+$/.test(ev.counterSteps ?? '') &&
  Number(ev.counterSteps) >= 2 &&
  /\d/.test(ev.counterTokens ?? '') &&
  (ev.counterElapsed ?? '') !== '' &&
  ev.planStepStatuses >= 1 &&
  ev.shotLoaded === true &&
  ev.timelineRows >= 1;

console.log(`E2E_RESULT ${JSON.stringify({ ...ev, ok })}`);
await browser.close();
relay.close();
process.exit(ok ? 0 : 1);
