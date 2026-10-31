// Criterion 29 driver (§16.4): headless Chromium against the real UI container.
// Runs inside docker/e2e. The UI is published on the host at 127.0.0.1:7070; this
// container reaches the host through host.docker.internal, so we relay container
// 127.0.0.1:7070 -> host.docker.internal:7070. That keeps the page origin
// 127.0.0.1:7070, which satisfies the server's Host/Origin guards unchanged.
// Usage: docker run --rm --add-host host.docker.internal:host-gateway -v "$PWD/tests:/tests:ro" <img>
// Prints progress lines and a final `E2E_RESULT {json}`; exit 0 on pass.

import fs from 'node:fs';
import net from 'node:net';
import { chromium } from 'playwright';

const TESTS = process.env.E2E_TESTS_DIR ?? '/tests';
const UPSTREAM = process.env.UI_UPSTREAM ?? 'host.docker.internal:7070';
const BASE = process.env.UI_BASE ?? 'http://127.0.0.1:7070';
const RELAY_PORT = Number(new URL(BASE).port || 80);

const ev = { phases: [] };
const step = (msg) => console.log(`[e2e] ${msg}`);
const seenPhase = (p) => {
  if (p && ev.phases.at(-1) !== p) ev.phases.push(p);
};

// --- loopback relay ---
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

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const blogStub = fs.readFileSync(`${TESTS}/stub/blog.json`, 'utf8');
// sleep-loop turns are 3 s each, so the orchestrator observes control/cancel within
// the runner's 30 s grace and writes run.json CANCELLED (unlike sleeper.json's 60 s nap).
const sleeperStub = fs.readFileSync(`${TESTS}/stub/sleep-loop.json`, 'utf8');
const blogSpec = readJson(`${TESTS}/specs/blog.json`);

const phaseText = async (page) =>
  (
    await page
      .locator('[data-testid="phase"]')
      .textContent()
      .catch(() => '')
  )?.trim() ?? '';
const waitPhase = async (page, wanted, timeoutMs) => {
  const t0 = Date.now();
  for (;;) {
    const p = await phaseText(page);
    seenPhase(p);
    if (Array.isArray(wanted) ? wanted.includes(p) : p === wanted) return p;
    if (Date.now() - t0 > timeoutMs) throw new Error(`phase '${p}' never became ${wanted} after ${timeoutMs}ms`);
    await page.waitForTimeout(700);
  }
};
const runIdFromUrl = (page) => /#\/run\/([0-9a-f-]+)/.exec(page.url())?.[1] ?? '';

const TERMINAL = ['passed', 'failed', 'unverified', 'cancelled'];

const fail = (msg) => {
  ev.error = msg;
  console.log(`E2E_RESULT ${JSON.stringify({ ...ev, ok: false })}`);
  process.exit(1);
};

let browser;
try {
  browser = await chromium.launch({ args: ['--no-sandbox'] });
} catch (err) {
  fail(`chromium launch: ${err}`);
}
const page = await (await browser.newContext()).newPage();
page.setDefaultTimeout(30000);

try {
  // (1) Create a run from the form: stub model, blog instructions, hero.png upload, review_plan ON.
  step('open #/new');
  await page.goto(`${BASE}/#/new`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#f-model option[value="stub"]', { state: 'attached' });
  ev.models = await page.$$eval('#f-model option', (os) => os.map((o) => o.value));
  await page.fill('#f-title', 'UI e2e blog');
  await page.fill('#f-instructions', blogSpec.goal);
  await page.fill('#f-start', blogSpec.start_url);
  await page.selectOption('#f-model', 'stub');
  await page.fill('#f-hosts', 'app.test:80');
  await page.fill('#f-stub', blogStub);
  for (const sel of [
    '[data-cred="TEST_USER_EMAIL"]',
    '[data-cred="TEST_USER_EMAIL:email"]',
    '[data-cred="TEST_USER_PASSWORD"]',
    '[data-cred="TEST_USER_PASSWORD:password"]',
  ]) {
    await page.check(sel);
  }
  await page.setInputFiles('#f-assets', `${TESTS}/specs/assets/hero.png`);
  await page.check('#f-review');
  await page.click('button[type="submit"]');
  step('submitted — waiting for run detail');
  await page.waitForURL(/#\/run\/[0-9a-f-]+/, { timeout: 30000 });
  const runId = runIdFromUrl(page);
  ev.runId = runId;

  // (2) Live phase updates → awaiting_approval, then Approve.
  ev.awaiting = (await waitPhase(page, 'awaiting approval', 300000)) === 'awaiting approval';
  await page.waitForSelector('[data-testid="plan-panel"] input', { timeout: 20000 });
  ev.planRows = await page.locator('[data-testid="plan-panel"] tbody tr').count();
  await page.click('button:has-text("Approve plan")');
  step('approved plan');

  // (3) Wait for terminal status via SSE-driven UI updates.
  const finalPhase = await waitPhase(page, TERMINAL, 420000);
  ev.status = finalPhase;

  // (4) Report view: verdict + conclusions, video + chapter seek, gallery.
  ev.verdict = (
    (await page
      .locator('[data-testid="verdict"]')
      .textContent()
      .catch(() => '')) ?? ''
  )
    .replace(/\s+/g, ' ')
    .trim();
  ev.conclusionsLen = (
    (await page
      .locator('[data-testid="conclusions"]')
      .textContent()
      .catch(() => '')) ?? ''
  ).trim().length;

  await page.waitForFunction(
    () => {
      const v = document.querySelector('video[data-testid="run-video"]');
      return v && v.readyState >= 2;
    },
    null,
    { timeout: 60000 },
  );
  ev.videoSrc = await page.getAttribute('video[data-testid="run-video"]', 'src');
  ev.videoReady = true;
  const starts = await page.$$eval('[data-testid="chapter-list"] .chapter', (els) => els.map((e) => Number(e.getAttribute('data-start'))));
  ev.chapters = starts.length;
  ev.chapterStarts = starts.slice(0, 5);
  // Seek the LAST chapter — a large, unambiguous target — then allow for play drift.
  const idx = starts.length - 1;
  await page.locator('[data-testid="chapter-list"] .chapter').nth(idx).click();
  await page.waitForTimeout(500);
  ev.seekedTo = await page.$eval('video[data-testid="run-video"]', (v) => v.currentTime);
  ev.seekTarget = starts[idx];
  ev.seekOk = ev.seekedTo >= (starts[idx] ?? 0) - 0.2 && ev.seekedTo <= (starts[idx] ?? 0) + 4;
  ev.galleryLoaded = await page.$$eval(
    '[data-testid="gallery"] img',
    (imgs) => imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
  );
  ev.timelineRows = await page.locator('[data-testid="timeline"] tbody tr').count();

  // (5) Rerun → the SPA navigates to the NEW run id. The rerun inherits
  // review_plan, so it parks in awaiting_approval — cancelling it there both
  // frees the queue slot and exercises cancel on a gated run.
  await page.click('button:has-text("Rerun")');
  await page.waitForFunction((old) => /#\/run\/[0-9a-f-]+/.test(location.hash) && !location.hash.endsWith(old), ev.runId, {
    timeout: 30000,
  });
  ev.rerunId = runIdFromUrl(page);
  ev.rerunNew = ev.rerunId !== ev.runId;
  await page.waitForSelector('[data-testid="phase"]', { timeout: 30000 });
  await waitPhase(page, ['awaiting approval', 'running', 'planning', 'starting', 'queued'], 120000);
  step(`cancelling rerun ${ev.rerunId}`);
  await page.click('button:has-text("Cancel")');
  ev.rerunCancel = await waitPhase(page, TERMINAL, 180000);

  // (6) A long-running (sleep-loop) stub run cancelled while running.
  await page.goto(`${BASE}/#/new`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#f-model option[value="stub"]', { state: 'attached' });
  await page.fill('#f-instructions', 'loop url assertions until cancelled');
  await page.fill('#f-start', 'http://app.test/admin/login');
  await page.selectOption('#f-model', 'stub');
  await page.fill('#f-hosts', 'app.test:80');
  await page.fill('#f-stub', sleeperStub);
  await page.click('button[type="submit"]');
  await page.waitForURL(/#\/run\/[0-9a-f-]+/, { timeout: 30000 });
  ev.cancelRunId = runIdFromUrl(page);
  step(`cancelling ${ev.cancelRunId}`);
  await waitPhase(page, ['running'], 300000);
  await page.click('button:has-text("Cancel")');
  ev.cancelStatus = await waitPhase(page, TERMINAL, 300000);
} catch (err) {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
}

const ok =
  ev.status === 'passed' &&
  (ev.verdict ?? '').includes('PASSED') &&
  ev.conclusionsLen > 0 &&
  ev.videoReady === true &&
  /\/artifacts\/[^/]+\/final\.mp4$/.test(ev.videoSrc ?? '') &&
  ev.chapters >= 1 &&
  ev.seekOk === true &&
  ev.galleryLoaded >= 1 &&
  ev.rerunNew === true &&
  ev.rerunCancel === 'cancelled' &&
  ev.cancelStatus === 'cancelled';

console.log(`E2E_RESULT ${JSON.stringify({ ...ev, ok })}`);
await browser.close();
relay.close();
process.exit(ok ? 0 : 1);
