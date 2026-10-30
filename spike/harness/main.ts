import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { startPageServers } from './pages.ts';
import { nowMs, sleep } from './util.ts';
import type { Adapter } from './adapter.ts';
import { ArmA } from './armA.ts';
import { ArmB } from './armB.ts';

const ARM = process.env.ARM || 'a';
const MODE = process.env.MODE || 'full';
const RESULTS = process.env.RESULTS_DIR || '/results';
const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';
const CHROME_SANDBOX = process.env.CHROME_SANDBOX || 'unknown';
const SCREEN_W = 1920;
const SCREEN_H = 1080;

const eventsPath = path.join(RESULTS, 'events.jsonl');
const eventsStream = fs.createWriteStream(eventsPath, MODE === 'swiftshader' ? { flags: 'a' } : {});
const emit = (obj: Record<string, unknown>) => eventsStream.write(JSON.stringify(obj) + '\n');

const webglRenderer = () => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl') as WebGLRenderingContext | null;
  if (!gl) return null;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
};

async function main() {
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.mkdirSync(path.join(RESULTS, 'logs'), { recursive: true });
  await startPageServers();
  const adapter: Adapter = ARM === 'b' ? new ArmB() : new ArmA();

  if (MODE === 'swiftshader') {
    const { page } = await adapter.connect(ARM === 'b' ? ['--enable-unsafe-swiftshader'] : []);
    await page.goto(`${BASE_URL}/blank`);
    let renderer: unknown = null;
    for (let i = 0; i < 6 && renderer === null; i++) {
      await sleep(800);
      renderer = await page.evaluate(webglRenderer);
    }
    fs.writeFileSync(path.join(RESULTS, 'swiftshader.json'), JSON.stringify({ webgl_swiftshader: renderer }));
    return;
  }

  const connectT0 = nowMs();
  const { page, context } = await adapter.connect([]);
  const connect_ms = nowMs() - connectT0;

  const checks: Record<string, unknown> = { native_ts: true, node_version: process.version };
  checks.screen_invariant = await page.evaluate(() => ({
    screenX: window.screenX,
    screenY: window.screenY,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  }));

  // ---- recording phase ----
  fs.writeFileSync(path.join(RESULTS, '.recording'), '1');
  const recT0 = nowMs();
  const video_start_ms = await adapter.startRecording();
  const first_frame_ms = nowMs() - recT0;
  emit({ type: 'RECORDING_START', t_ms: nowMs(), video_start_ms });

  const segment = async (name: string, fn: () => Promise<void>) => {
    adapter.onSegmentStart(name);
    emit({ type: 'SEGMENT_START', name, t_ms: nowMs() });
    await fn();
    emit({ type: 'SEGMENT_END', name, t_ms: nowMs() });
    adapter.onSegmentEnd(name);
  };

  const syncSegment = async (name: string, clickFn: (x: number, y: number) => Promise<void>) => {
    await segment(name, async () => {
      await page.goto(`${BASE_URL}/sync`);
      await sleep(1000);
      for (let i = 0; i < 10; i++) {
        await clickFn(220, 200);
        await sleep(700);
      }
      await sleep(400);
      const clicks = await page.evaluate(() => (window as any).__clicks || []);
      for (const c of clicks as any[]) {
        emit({ type: 'PAGE_CLICK', segment: name, i: c.i, page_click_ms: c.page_click_ms, page_raf_ms: c.page_raf_ms, color_after: c.color_after });
      }
    });
  };

  await syncSegment('sync_cdp', (x, y) => page.mouse.click(x, y));
  if (ARM === 'a') await syncSegment('sync_os', (x, y) => adapter.osClick(x, y));

  await segment('anim', async () => {
    await page.goto(`${BASE_URL}/anim`);
    await sleep(3000);
  });

  await segment('quality', async () => {
    await page.goto(`${BASE_URL}/quality`);
    await sleep(1500);
    await page.screenshot({ path: path.join(RESULTS, 'quality.png') });
    await sleep(1500);
  });

  await segment('popup', async () => {
    await page.goto(`${BASE_URL}/popup`);
    const popupPromise = context.waitForEvent('page', { timeout: 10000 });
    await page.mouse.click(60, 30);
    const popup = await popupPromise;
    await sleep(2000);
    await popup.close();
    await sleep(500);
  });

  await adapter.stopRecording();
  emit({ type: 'RECORDING_STOP', t_ms: nowMs() });
  try { fs.unlinkSync(path.join(RESULTS, '.recording')); } catch {}

  // ---- functional checks ----
  // canvas_click_cdp
  await page.goto(`${BASE_URL}/canvas`);
  await page.mouse.click(300, 550);
  await sleep(300);
  checks.canvas_click_cdp = await page.evaluate(() => !!(window as any).__canvasHit);
  if (ARM === 'a') {
    await page.goto(`${BASE_URL}/canvas`);
    await adapter.osClick(300, 550);
    await sleep(300);
    checks.canvas_click_os = await page.evaluate(() => !!(window as any).__canvasHit);
  }

  // xorigin_iframe_click_cdp
  await page.goto(`${BASE_URL}/iframe`);
  await page.frameLocator('iframe').locator('button').waitFor({ timeout: 10000 }).catch(() => {});
  await sleep(500);
  await page.mouse.click(900, 500);
  await sleep(400);
  checks.xorigin_iframe_click_cdp = await page.evaluate(() => !!(window as any).__iframeHit);
  if (ARM === 'a') {
    await page.goto(`${BASE_URL}/iframe`);
    await sleep(700);
    await adapter.osClick(900, 500);
    await sleep(400);
    checks.xorigin_iframe_click_os = await page.evaluate(() => !!(window as any).__iframeHit);
  }

  // confirm_default
  await page.goto(`${BASE_URL}/confirm`);
  const beats0 = await page.evaluate(() => (window as any).__beats);
  await page.mouse.click(220, 200);
  await sleep(700);
  let confirmValue: unknown = null;
  let confirmErr: string | null = null;
  try {
    confirmValue = await page.evaluate(() => (window as any).__confirmResult ?? null);
  } catch (e) {
    confirmErr = String(e);
  }
  const beats1 = await page.evaluate(() => (window as any).__beats).catch(() => null);
  checks.confirm_default = { value: confirmValue, error: confirmErr, responsive: typeof beats1 === 'number' && beats1 > (beats0 as number) };

  // webgl_default
  await page.goto(`${BASE_URL}/blank`);
  checks.webgl_default = await page.evaluate(webglRenderer);

  // sandbox
  let sandboxText: string | null = null;
  let sandboxErr: string | null = null;
  try {
    await page.goto('chrome://sandbox', { timeout: 10000 });
    sandboxText = (await page.evaluate(() => document.body.innerText)).slice(0, 800);
  } catch (e) {
    sandboxErr = String(e);
  }
  checks.sandbox = {
    text: sandboxText,
    error: sandboxErr,
    chrome_sandbox_mode: CHROME_SANDBOX,
    seccomp_profile_used: CHROME_SANDBOX === 'seccomp' || CHROME_SANDBOX === 'seccomp+caps-dropped',
    no_sandbox_flag_used: CHROME_SANDBOX === 'no-sandbox',
  };

  await sleep(500);

  // ---- Arm B specific checks ----
  if (ARM === 'b') {
    const bpage = page;
    const videoPath = path.join(RESULTS, 'video.webm');
    checks.video_path_written = fs.existsSync(videoPath)
      ? { exists: true, size: fs.statSync(videoPath).size }
      : { exists: false, size: 0 };

    await bpage.goto(`${BASE_URL}/button`).catch(async () => {
      await sleep(500);
      await bpage.goto(`${BASE_URL}/button`);
    });
    await bpage.screencast.hideActions();
    await sleep(300);
    const domState = async () => bpage.evaluate(() => ({
      count: document.querySelectorAll('*').length,
      tagNames: [...new Set(Array.from(document.querySelectorAll('*')).map((el) => el.tagName))],
    }));
    const dom_before = await domState();
    fs.writeFileSync(path.join(RESULTS, 'aria_before.txt'), await bpage.ariaSnapshot({ mode: 'ai' }));
    await bpage.screencast.showActions();
    await bpage.mouse.click(220, 200);
    await bpage.screenshot({ path: path.join(RESULTS, 'decor_on.png') });
    const dom_after = await domState();
    fs.writeFileSync(path.join(RESULTS, 'aria_after.txt'), await bpage.ariaSnapshot({ mode: 'ai' }));
    await bpage.screencast.hideActions();
    await bpage.screenshot({ path: path.join(RESULTS, 'decor_off.png') });
    checks.decoration_leak = { dom_before, dom_after };

    // aria_ref_click
    const snap = await bpage.ariaSnapshot({ mode: 'ai' });
    const refMatch = snap.match(/\[ref=(\w+)\]/);
    if (refMatch) {
      const hitsBefore = await bpage.evaluate(() => (window as any).__buttonHit || 0);
      await bpage.getByRef(refMatch[1]).click();
      await sleep(200);
      const hitsAfter = await bpage.evaluate(() => (window as any).__buttonHit || 0);
      checks.aria_ref_click = { ref: refMatch[1], hits_before: hitsBefore, hits_after: hitsAfter, clicked: (hitsAfter as number) > (hitsBefore as number) };
    } else {
      checks.aria_ref_click = { error: 'no ref found in aria snapshot', snapshot: snap.slice(0, 400) };
    }

    checks.popup_in_video_note = 'page.screencast records a single Page/target. The target=_blank popup is a separate Page; the screencast attached to the main page does not capture its content. Recording the popup requires calling screencast.start() on the popup Page itself (second video file).';
  }

  fs.writeFileSync(path.join(RESULTS, 'checks.json'), JSON.stringify(checks, null, 2));
  fs.writeFileSync(path.join(RESULTS, 'timings.json'), JSON.stringify({
    compose_up_to_ready_s: null,
    connect_ms,
    record_start_to_first_frame_ms: first_frame_ms,
  }, null, 2));
}

main().then(
  () => { eventsStream.end(); process.exit(0); },
  (e) => {
    fs.mkdirSync(RESULTS, { recursive: true });
    fs.writeFileSync(path.join(RESULTS, 'error.txt'), String(e && e.stack || e));
    eventsStream.end();
    process.exit(1);
  },
);
