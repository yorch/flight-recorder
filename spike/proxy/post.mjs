import fs from 'node:fs';

const RES = process.env.RESULTS_DIR || '../results/proxy';
const checks = fs.existsSync(`${RES}/checks.json`)
  ? JSON.parse(fs.readFileSync(`${RES}/checks.json`, 'utf8'))
  : {};

if (fs.existsSync(`${RES}/direct.json`)) {
  Object.assign(checks, JSON.parse(fs.readFileSync(`${RES}/direct.json`, 'utf8')));
}

// ground truth: every k= marker + UDP datagrams + distinct host_headers in internet.jsonl
const lines = fs.existsSync(`${RES}/internet/internet.jsonl`)
  ? fs.readFileSync(`${RES}/internet/internet.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  : [];
const kMarkers = new Set();
const udpEntries = [];
const hosts = new Set();
for (const l of lines) {
  const m = (l.path || '').match(/[?&]k=([A-Za-z0-9_]+)/);
  if (m) kMarkers.add(m[1]);
  if (l.proto === 'udp') udpEntries.push(l);
  if (l.host_header) hosts.add(l.host_header);
}
checks.ground_truth = {
  k_markers: [...kMarkers].sort(),
  udp_entries: udpEntries,
  host_headers: [...hosts].sort(),
  total_lines: lines.length,
};

// dns_on_denied: quote cache.log for allowed vs denied lookups
const cacheLog = fs.existsSync(`${RES}/squid/cache.log`)
  ? fs.readFileSync(`${RES}/squid/cache.log`, 'utf8').split('\n')
  : [];
const pick = (re) => cacheLog.filter((l) => re.test(l)).slice(0, 6);
checks.dns_on_denied = {
  allowed_test_lines: pick(/allowed\.test/),
  evil_test_lines: pick(/evil\.test/),
  llm_test_lines: pick(/llm\.test/),
  cdn_test_lines: pick(/cdn\.test/),
};

if (fs.existsSync(`${RES}/real.json`)) {
  checks.real_internet_https = JSON.parse(fs.readFileSync(`${RES}/real.json`, 'utf8'));
}

fs.writeFileSync(`${RES}/checks.json`, JSON.stringify(checks, null, 2));
console.log('post: merged into checks.json');
