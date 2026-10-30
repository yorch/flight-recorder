import { createRequire } from 'node:module';

const { chromium } = createRequire('/app/package.json')('playwright-core');
const b = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9222');
const p = b.contexts()[0].pages()[0] ?? (await b.contexts()[0].newPage());
await p.goto('chrome://sandbox');
console.log('SANDBOX_TEXT_START');
console.log((await p.evaluate('document.body.innerText')).slice(0, 400));
console.log('SANDBOX_TEXT_END');
await b.close();
