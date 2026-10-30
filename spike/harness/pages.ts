import http from 'node:http';

const ALT = process.env.ALT_URL || 'http://127.0.0.1:8081';

const syncPage = `<!doctype html><html><body style="margin:0;background:#ffffff">
<button id="b" style="position:absolute;left:160px;top:170px;width:120px;height:60px">B</button>
<script>
window.__clicks = [];
let i = 0, red = false;
document.getElementById('b').addEventListener('click', () => {
  const t = performance.timeOrigin + performance.now();
  red = !red;
  document.body.style.background = red ? '#ff0000' : '#ffffff';
  requestAnimationFrame((ts) => {
    window.__clicks.push({ i: i++, page_click_ms: t, page_raf_ms: performance.timeOrigin + ts, color_after: red ? 'red' : 'white' });
  });
});
</script></body></html>`;

const animPage = `<!doctype html><html><body style="margin:0;background:#ffffff;overflow:hidden">
<div style="position:absolute;left:760px;top:340px;width:400px;height:400px;background:#2244cc;animation:rot 2s linear infinite"></div>
<style>@keyframes rot { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }</style>
</body></html>`;

const lorem = 'The quick brown fox jumps over the lazy dog. '.repeat(8);
const paras = Array.from({ length: 40 }, () => `<p style="font-size:12px;color:#000;margin:0;line-height:1.35">${lorem}</p>`).join('');
const qualityPage = `<!doctype html><html><body style="margin:0;background:#ffffff">
${paras}
<div style="position:absolute;left:0;bottom:120px;width:1920px;height:80px;background:linear-gradient(to right,#ff0000,#ff7f00,#ffff00,#00ff00,#0000ff,#8b00ff)"></div>
</body></html>`;

const popupPage = `<!doctype html><html><body style="margin:0;background:#ffffff">
<a href="/green" target="_blank" style="position:absolute;left:10px;top:10px;width:100px;height:40px;display:block;background:#dddddd">open</a>
</body></html>`;

const greenPage = `<!doctype html><html><body style="margin:0;background:#00ff00;height:100vh"></body></html>`;

const canvasPage = `<!doctype html><html><body style="margin:0;background:#ffffff">
<canvas id="c" width="400" height="300" style="position:absolute;left:100px;top:400px;background:#eeeeee"></canvas>
<script>
document.getElementById('c').addEventListener('click', () => { window.__canvasHit = true; });
</script></body></html>`;

const iframePage = `<!doctype html><html><body style="margin:0;background:#ffffff">
<iframe src="${ALT}/frame-btn" style="position:absolute;left:700px;top:400px;width:400px;height:200px;border:1px solid #000"></iframe>
<script>
window.addEventListener('message', (e) => { if (e.data === 'hit') window.__iframeHit = true; });
</script></body></html>`;

const frameBtnPage = `<!doctype html><html><body style="margin:0">
<button style="position:fixed;inset:0;width:100%;height:100%" onclick="parent.postMessage('hit','*')">hit</button>
</body></html>`;

const confirmPage = `<!doctype html><html><body style="margin:0;background:#ffffff">
<button id="b" style="position:absolute;left:160px;top:170px;width:120px;height:60px"
  onclick="window.__confirmResult = confirm('ok?')">confirm</button>
<script>window.__beats = 0; setInterval(() => { window.__beats++; }, 100);</script>
</body></html>`;

const buttonPage = `<!doctype html><html><body style="margin:0;background:#ffffff">
<button id="b" style="position:absolute;left:160px;top:170px;width:120px;height:60px"
  onclick="window.__buttonHit = (window.__buttonHit || 0) + 1">Click me</button>
</body></html>`;

const blankPage = `<!doctype html><html><body style="margin:0;background:#ffffff"></body></html>`;

const routes: Record<string, string> = {
  '/sync': syncPage,
  '/anim': animPage,
  '/quality': qualityPage,
  '/popup': popupPage,
  '/green': greenPage,
  '/canvas': canvasPage,
  '/iframe': iframePage,
  '/frame-btn': frameBtnPage,
  '/confirm': confirmPage,
  '/button': buttonPage,
  '/blank': blankPage,
};

export function startPageServers(): Promise<void> {
  const handler = (_req: http.IncomingMessage, res: http.ServerResponse) => {
    const path = (_req.url || '/').split('?')[0];
    const body = routes[path];
    if (body === undefined) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };
  const s1 = http.createServer(handler);
  const s2 = http.createServer(handler);
  return new Promise((resolve) => {
    let n = 0;
    const done = () => { if (++n === 2) resolve(); };
    s1.listen(8080, '0.0.0.0', done);
    s2.listen(8081, '0.0.0.0', done);
  });
}
