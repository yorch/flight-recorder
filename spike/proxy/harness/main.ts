import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { chromium } from 'playwright-core';

const RESULTS = process.env.RESULTS_DIR || '/results';
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const MODE = process.env.MODE || 'full';
const checks: Record<string, unknown> = {};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tryFetch(url: string) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return { ok: true, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: String(e), ms: Date.now() - t0 };
  }
}

async function main() {
  fs.mkdirSync(RESULTS, { recursive: true });

  if (MODE === 'real') {
    const browser = await chromium.connectOverCDP(CDP_URL);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.newPage());
    const out: Record<string, unknown> = {};
    try {
      const resp = await page.goto('https://example.com/', { timeout: 20000 });
      out.example_com = { ok: true, status: resp?.status(), url: page.url(), title: await page.title() };
    } catch (e) {
      out.example_com = { ok: false, error: String(e).slice(0, 500) };
    }
    try {
      const resp = await page.goto('https://example.org/', { timeout: 20000 });
      const text = await page.evaluate(() => document.body?.innerText?.slice(0, 300) ?? '');
      out.example_org = { ok: true, status: resp?.status(), url: page.url(), text };
    } catch (e) {
      out.example_org = { ok: false, error: String(e).slice(0, 500) };
    }
    fs.writeFileSync(path.join(RESULTS, 'real.json'), JSON.stringify(out, null, 2));
    return;
  }

  // check 2: CDP connect with env proxy + screen invariant
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  checks.cdp_with_env_proxy = {
    connected: true,
    invariant: await page.evaluate(() => ({
      screenX: window.screenX, screenY: window.screenY,
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    })),
  };

  // check 3: allowed navigation + sub-resource probe
  const resp = await page.goto('http://allowed.test:8080/probe', { timeout: 20000 });
  checks.allowed_navigation = { status: resp?.status() };
  await sleep(5000);
  checks.probe = await page.evaluate(() => (window as any).__probe);

  // check 4: blocked navigation
  try {
    const r = await page.goto('http://evil.test:8080/', { timeout: 15000 });
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 400) ?? '');
    checks.blocked_navigation = { threw: false, status: r?.status(), url: page.url(), text };
  } catch (e) {
    checks.blocked_navigation = { threw: true, error: String(e).slice(0, 600) };
  }

  // check 5: orchestrator-side fetch through agent proxy port
  checks.orchestrator_fetch = {
    env_proxy: process.env.NODE_USE_ENV_PROXY || null,
    llm: await tryFetch('http://llm.test:8080/agent?k=agent_ok'),
    evil: await tryFetch('http://evil.test:8080/agent?k=agent_evil'),
    allowed_via_agent_port: await tryFetch('http://allowed.test:8080/agent?k=agent_to_allowed'),
    no_proxy_env: await new Promise((resolve) => {
      execFile('node', ['-e', `
        fetch('http://llm.test:8080/agent?k=agent_noproxy',{signal:AbortSignal.timeout(6000)})
          .then(r=>{console.log(JSON.stringify({ok:true,status:r.status}));process.exit(0)})
          .catch(e=>{console.log(JSON.stringify({ok:false,error:String(e)}));process.exit(0)})
      `], { env: { PATH: process.env.PATH } }, (err, stdout) => {
        try { resolve(JSON.parse(String(stdout).trim().split('\n').pop()!)); }
        catch { resolve({ ok: false, error: `exec: ${String(err)} ${stdout}` }); }
      });
    }),
  };

  // check 7: chrome://sandbox
  try {
    await page.goto('chrome://sandbox', { timeout: 10000 });
    checks.sandbox_still_on = (await page.evaluate(() => document.body.innerText)).slice(0, 800);
  } catch (e) {
    checks.sandbox_still_on = { error: String(e).slice(0, 300) };
  }

  checks.native_ts = true;
  checks.node_version = process.version;
  fs.writeFileSync(path.join(RESULTS, 'checks.json'), JSON.stringify(checks, null, 2));
}

main().then(
  () => process.exit(0),
  (e) => {
    fs.mkdirSync(RESULTS, { recursive: true });
    fs.writeFileSync(path.join(RESULTS, 'error.txt'), String(e?.stack || e));
    process.exit(1);
  },
);
