import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';

const vtt = fs.readFileSync(process.env.VTT_FILE, 'utf8');
const srv = http.createServer((q, s) => {
  if (q.url === '/c.vtt') {
    s.setHeader('content-type', 'text/vtt');
    s.end(vtt);
  } else s.end('<html><body><video preload="auto"><track kind="chapters" src="/c.vtt" default></video></body></html>');
});
await new Promise((r) => srv.listen(0, r));
const { chromium } = createRequire('/app/package.json')('playwright-core');
const b = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9222');
const p = b.contexts()[0].pages()[0] ?? (await b.contexts()[0].newPage());
await p.goto(`http://127.0.0.1:${srv.address().port}/`);
await p.evaluate("const t=document.querySelector('track').track;t.mode='hidden';document.querySelector('video').load()");
try {
  await p.waitForFunction("document.querySelector('track').track.cues && document.querySelector('track').track.cues.length>0", {
    timeout: 5000,
  });
} catch {}
const info = await p.evaluate(
  "({rs:document.querySelector('track').track.readyState,n:document.querySelector('track').track.cues?document.querySelector('track').track.cues.length:-1})",
);
console.log(`VTT_CUES ${info.n} RS ${info.rs}`);
srv.close();
await b.close();
