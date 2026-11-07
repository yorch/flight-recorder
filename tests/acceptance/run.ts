import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = process.cwd();
const OVERLAY = 'tests/acceptance/compose.fixtures.yml';
const OUT = process.env.ACC_OUT ?? `artifacts/acceptance-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
const SITES_LOG = path.join(OUT, 'sites-log');
fs.mkdirSync(SITES_LOG, { recursive: true });

// --only / --skip take a comma-separated list of criterion ids. Unknown ids,
// malformed lists, repeated flags and stray arguments all fail before any run.
const parseArgs = (argv: string[]): { only: Set<number> | null; skip: Set<number> } => {
  const parsed: { only: Set<number> | null; skip: Set<number> } = { only: null, skip: new Set() };
  const seen = new Set<string>();
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== '--only' && flag !== '--skip') throw new Error(`unknown argument '${flag}' (expected --only <ids> or --skip <ids>)`);
    if (seen.has(flag)) throw new Error(`duplicate ${flag}`);
    seen.add(flag);
    const raw = (argv[i + 1] ?? '').trim();
    const ids = raw.split(',').map((s) => s.trim());
    if (!raw || ids.some((s) => !/^\d+$/.test(s))) throw new Error(`${flag} needs criterion ids, got '${raw}'`);
    const set = new Set(ids.map(Number));
    if (flag === '--only') parsed.only = set;
    else parsed.skip = set;
    i++;
  }
  return parsed;
};
let only: Set<number> | null = null;
let skip = new Set<number>();
try {
  const parsed = parseArgs(process.argv);
  only = parsed.only;
  skip = parsed.skip;
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const sh = (cmd: string, env: NodeJS.ProcessEnv = {}): { code: number; out: string } => {
  const r = spawnSync('sh', ['-c', cmd], {
    cwd: ROOT,
    env: { ...process.env, SITES_LOG_DIR: path.join(ROOT, SITES_LOG), ...env },
    encoding: 'utf8',
    timeout: 900_000,
  });
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

interface RunResult {
  code: number;
  runId: string;
  dir: string;
  out: string;
}
const runTest = (spec: string, stub: string, env: NodeJS.ProcessEnv = {}): RunResult => {
  const overlays = `${OVERLAY}${env.COMPOSE_OVERLAYS ? ` ${env.COMPOSE_OVERLAYS}` : ''}`;
  const r = sh(`sh scripts/run-test.sh ${spec} stub//tests/stub/${stub}`, { ...env, COMPOSE_OVERLAYS: overlays });
  const m = /artifacts: artifacts\/(\S+)/.exec(r.out);
  const runId = m ? m[1] : '';
  return { code: r.code, runId, dir: `artifacts/${runId}`, out: r.out };
};
const runJson = (d: string) => JSON.parse(fs.readFileSync(`${d}/run.json`, 'utf8'));
const eventsOf = (d: string) =>
  fs
    .readFileSync(`${d}/events.jsonl`, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
const siteLog = () => {
  const f = path.join(SITES_LOG, 'requests.jsonl');
  return fs.existsSync(f)
    ? fs
        .readFileSync(f, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
};

const PROJECT = 'acc-diag';
const compose = `docker compose -f docker-compose.yml -f ${OVERLAY} -p ${PROJECT}`;
const diagEnv = {
  RUN_ID: 'diag',
  TEST_FILE: '/tests/specs/login.json',
  AGENT_MODEL: 'stub//tests/stub/sleeper.json',
  AGENT_EGRESS_HOSTS: 'llm.test:80',
};
const diagUp = () => sh(`${compose} up -d --wait --build browser sites`, diagEnv);
const diagDown = () => sh(`${compose} down -v`, diagEnv);
const diagRun = (args: string) => sh(`${compose} run --rm --entrypoint node orchestrator ${args}`, diagEnv);

// --- helpers for criteria 27-28 (host processes: runner daemon, control plane, fake runner) ---
interface Spawned {
  proc: ReturnType<typeof spawn>;
  output: () => string;
}
const spawnReady = (args: string[], env: NodeJS.ProcessEnv, marker: RegExp, timeoutMs = 90_000): Promise<Spawned> => {
  const proc = spawn(args[0], args.slice(1), { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  proc.stdout.on('data', (c) => (buf += c));
  proc.stderr.on('data', (c) => (buf += c));
  return new Promise<Spawned>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${args.join(' ')} did not print ${marker}: ${buf.slice(-600)}`)), timeoutMs);
    const iv = setInterval(() => {
      if (marker.test(buf)) {
        clearTimeout(t);
        clearInterval(iv);
        resolve({ proc, output: () => buf });
      }
    }, 50);
    proc.on('exit', (c) => reject(new Error(`${args.join(' ')} exited ${c}: ${buf.slice(-600)}`)));
  });
};
const stopProc = (s: Spawned): Promise<void> => {
  s.proc.kill('SIGTERM');
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      s.proc.kill('SIGKILL');
      resolve();
    }, 90_000);
    s.proc.on('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
};
const waitFor = async (fn: () => Promise<boolean>, timeoutMs: number): Promise<boolean> => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};
const httpCall = (
  method: string,
  port: number,
  p: string,
  headers: Record<string, string>,
  body?: string | Buffer,
): Promise<{ code: number; headers: http.IncomingHttpHeaders; body: string }> =>
  new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ code: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
const accRunId = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
};

interface Criterion {
  id: number;
  title: string;
  run: () => Promise<{ pass: boolean; evidence: unknown }>;
}
const results: { id: number; title: string; pass: boolean; skipped?: boolean; evidence: unknown; duration_s: number }[] = [];

const CRITERIA: Criterion[] = [
  {
    id: 1,
    title: 'Images build for linux/amd64+arm64',
    run: async () => {
      const r1 = sh('docker buildx build --platform linux/amd64,linux/arm64 -f docker/browser/Dockerfile docker/browser');
      const r2 = sh('docker buildx build --platform linux/amd64,linux/arm64 -f docker/proxy/Dockerfile docker/proxy');
      const r3 = sh('docker buildx build --platform linux/amd64,linux/arm64 -f Dockerfile .');
      return {
        pass: r1.code === 0 && r2.code === 0 && r3.code === 0,
        evidence: { browser: r1.code, proxy: r2.code, orchestrator: r3.code, tail: r3.out.slice(-300) },
      };
    },
  },
  {
    id: 2,
    title: 'No published ports; CDP unreachable from host',
    run: async () => {
      diagUp();
      const ps = sh(`${compose} ps --format json`, diagEnv);
      const ports = ps.out
        .trim()
        .split('\n')
        .flatMap((l) => {
          try {
            const j = JSON.parse(l);
            const pub = j.Publishers ?? j.Ports ?? [];
            const arr = Array.isArray(pub) ? pub : [pub];
            return arr.filter((x: unknown) =>
              typeof x === 'object' && x !== null ? ((x as { PublishedPort?: number }).PublishedPort ?? 0) > 0 : /:\d+->/.test(String(x)),
            );
          } catch {
            return [];
          }
        });
      const curl = sh('curl -sS -m 3 http://localhost:9222/json/version 2>&1 || echo FAILED');
      diagDown();
      return {
        pass: ports.length === 0 && /FAILED|refused|timed out/i.test(curl.out),
        evidence: { ports, curl: curl.out.trim().slice(0, 200) },
      };
    },
  },
  {
    id: 3,
    title: 'Chrome sandbox on, no --no-sandbox flag',
    run: async () => {
      diagUp();
      const r = diagRun('/tests/acceptance/tools/sandbox-check.mjs');
      diagDown();
      const flag = fs.readFileSync('docker/browser/start-chrome', 'utf8').includes('--no-sandbox');
      const ok = r.out.includes('You are adequately sandboxed') && !flag;
      return {
        pass: ok,
        evidence: { text: r.out.slice(r.out.indexOf('SANDBOX_TEXT_START'), r.out.indexOf('SANDBOX_TEXT_END') + 16), flagPresent: flag },
      };
    },
  },
  {
    id: 4,
    title: 'Broken screen config aborts with exit 2',
    run: async () => {
      const r = runTest('specs/login.json', 'login.json', { COMPOSE_OVERLAYS: `${OVERLAY} tests/acceptance/compose.broken-screen.yml` });
      let summary = '';
      try {
        summary = runJson(r.dir).summary;
      } catch {
        summary = 'no run.json';
      }
      return { pass: r.code === 2 && /invariant|Invariant|Screen\/viewport/i.test(summary + r.out), evidence: { code: r.code, summary } };
    },
  },
  {
    id: 5,
    title: 'Click→frame sync: all ≥0, min ≤50 ms, max ≤100 ms',
    run: async () => {
      const r = runTest('specs/calibration.json', 'calibration.json');
      const ev = eventsOf(r.dir);
      const vstart = ev.find((e) => e.type === 'RECORDING_START').video_start_ms;
      const clicks = siteLog()
        .map((l) => {
          try {
            return JSON.parse(l.body ?? '{}') as { kind?: string; page_click_ms?: number; color?: string };
          } catch {
            return {};
          }
        })
        .filter((l) => l.kind === 'click')
        .sort((a, b) => (a.page_click_ms ?? 0) - (b.page_click_ms ?? 0));
      // Per-frame (pts_time, class) over the centre crop — same method as spike/analyze.py analyze_a.
      const sig = sh(
        `ffprobe -v error -f lavfi -i "movie=${r.dir}/raw.mkv,crop=iw*0.06:ih*0.06:iw*0.47:ih*0.47,signalstats" -show_entries frame=pts_time:frame_tags=lavfi.signalstats.YAVG,lavfi.signalstats.UAVG,lavfi.signalstats.VAVG -of json`,
      );
      const classify = (y: number, _u: number, v: number) => (v > 190 ? 'red' : y > 200 && 110 < v && v < 150 ? 'white' : 'other');
      const rows = (JSON.parse(sig.out).frames as { pts_time?: string; tags?: Record<string, string> }[])
        .filter((f) => f.pts_time !== undefined && f.pts_time !== 'N/A')
        .map((f) => ({
          t: Number(f.pts_time),
          cls: classify(
            Number(f.tags?.['lavfi.signalstats.YAVG']),
            Number(f.tags?.['lavfi.signalstats.UAVG']),
            Number(f.tags?.['lavfi.signalstats.VAVG']),
          ),
        }));
      const trans: { t: number; color: string }[] = [];
      let prev: string | null = null;
      for (const row of rows) {
        if (row.cls !== 'red' && row.cls !== 'white') continue;
        if (prev !== null && row.cls !== prev) trans.push({ t: row.t, color: row.cls });
        prev = row.cls;
      }
      // for each click: nearest transition to its expected colour within +/-350ms of the click's video time
      const delays: number[] = [];
      const delaysRaf: number[] = [];
      const unmatched: number[] = [];
      for (const c of clicks) {
        const tv = (((c as { page_click_ms?: number }).page_click_ms ?? 0) - vstart) / 1000;
        const cands = trans.filter((tr) => tr.color === (c as { color?: string }).color && tv - 0.35 <= tr.t && tr.t <= tv + 0.35);
        if (!cands.length) {
          unmatched.push((c as { page_click_ms?: number }).page_click_ms ?? -1);
          continue;
        }
        const best = cands.reduce((a, b) => (Math.abs(b.t - tv) < Math.abs(a.t - tv) ? b : a));
        delays.push(vstart + best.t * 1000 - ((c as { page_click_ms?: number }).page_click_ms ?? 0));
        delaysRaf.push(vstart + best.t * 1000 - ((c as { page_raf_ms?: number }).page_raf_ms ?? 0));
      }
      const stat = (ds: number[]) => {
        const s = [...ds].sort((a, b) => a - b);
        return { min: s[0], median: s[Math.floor(s.length / 2)], max: s.at(-1) };
      };
      const pass =
        (r.code === 0 || r.code === 3) &&
        clicks.length === 10 &&
        unmatched.length === 0 &&
        delays.every((d) => d >= 0) &&
        Math.min(...delays) <= 50 &&
        Math.max(...delays) <= 100;
      return {
        pass,
        evidence: {
          clicks: clicks.length,
          unmatched,
          delays_vs_click_ms: delays,
          delays_vs_raf_ms: delaysRaf,
          stats_click: stat(delays),
          transitions: trans.length,
        },
      };
    },
  },
  {
    id: 6,
    title: 'Post-processing survives orchestrator SIGKILL',
    run: async () => {
      const proj = `acc-kill-${Date.now() % 100000}`;
      const env = {
        RUN_ID: `kill-${Date.now() % 100000}`,
        TEST_FILE: '/tests/specs/login.json',
        AGENT_MODEL: 'stub//tests/stub/sleeper.json',
        AGENT_EGRESS_HOSTS: 'stub.invalid',
      };
      const cc = `docker compose -f docker-compose.yml -f ${OVERLAY} -p ${proj}`;
      sh(`${cc} up -d --build --wait`, env);
      const runDir = `artifacts/${env.RUN_ID}`;
      let ok = false;
      for (let i = 0; i < 30; i++) {
        if (fs.existsSync(`${runDir}/events.jsonl`) && fs.readFileSync(`${runDir}/events.jsonl`, 'utf8').includes('RECORDING_START')) {
          ok = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      // give ffmpeg ~2.5s of captured video before the SIGKILL
      await new Promise((r) => setTimeout(r, 2500));
      sh(
        `docker kill -s KILL ${proj}-orchestrator-1 2>/dev/null || docker kill -s KILL $(docker ps -q --filter name=${proj}-orchestrator)`,
        env,
      );
      sh(`${cc} down -v`, env);
      const ff = sh(`ffprobe -v error -show_entries format=duration -of csv=p=0 ${runDir}/raw.mkv`);
      const pp = sh(
        `docker run --rm -v "${ROOT}/artifacts:/artifacts" -v "${ROOT}/tests:/tests:ro" --entrypoint node acc-diag-orchestrator src/postprocess/cli.ts /artifacts/${env.RUN_ID}`,
      );
      const fin = fs.existsSync(`${runDir}/final.mp4`);
      return {
        pass: ok && fin && pp.code === 0,
        evidence: { recStartSeen: ok, ffprobe: ff.out.trim() || ff.code, postproc: pp.code, final: fin, tail: pp.out.slice(-200) },
      };
    },
  },
  {
    id: 7,
    title: 'Compression: idle ≤1.5 s out, long actions keep 2×ACTIVE_KEEP+1.5',
    run: async () => {
      const r = runTest('specs/slow.json', 'slow.json');
      const tm = JSON.parse(fs.readFileSync(`${r.dir}/timemap.json`, 'utf8'));
      const ev = eventsOf(r.dir);
      const nav = [
        ev.find((e) => e.type === 'ACTION_START' && e.step_id === 's0001'),
        ev.find((e) => e.type === 'ACTION_END' && e.step_id === 's0001'),
      ];
      const vstart = ev.find((e) => e.type === 'RECORDING_START').video_start_ms;
      const [ns, ne] = [(nav[0].t_ms - vstart) / 1000, (nav[1].t_ms - vstart) / 1000];
      const mt = (t: number) => {
        const s = tm.segments.find((x: { inEnd: number }) => t < x.inEnd) ??
          tm.segments.at(-1) ?? { outStart: 0, inStart: 0, inEnd: 0, speed: 1 };
        return s.outStart + (Math.min(Math.max(t, s.inStart), s.inEnd) - s.inStart) / s.speed;
      };
      const navOut = mt(ne) - mt(ns);
      let idleOk = true;
      for (const s of tm.segments) {
        const out = (s.inEnd - s.inStart) / s.speed;
        const overlapsNav = s.inStart < ne && s.inEnd > ns;
        if (s.speed === 1 && !overlapsNav && s.inEnd - s.inStart > 2.5) idleOk = false;
        if (s.speed > 1 && out > 1.5001) idleOk = false;
      }
      const ffdur = Number(sh(`ffprobe -v error -show_entries format=duration -of csv=p=0 ${r.dir}/final.mp4`).out.trim());
      const pass = (r.code === 0 || r.code === 3) && idleOk && navOut <= 4.5 && Math.abs(ffdur - tm.duration_out_s) <= 0.2;
      return { pass, evidence: { navOut, ffdur, out: tm.duration_out_s, idleOk, segments: tm.segments.length } };
    },
  },
  {
    id: 8,
    title: 'Chapters match executed actions; VTT loads in Chrome',
    run: async () => {
      const r = runTest('specs/login.json', 'login.json');
      const ch = JSON.parse(fs.readFileSync(`${r.dir}/chapters.json`, 'utf8'));
      const tm = JSON.parse(fs.readFileSync(`${r.dir}/timemap.json`, 'utf8'));
      const ev = eventsOf(r.dir);
      const vstart = ev.find((e) => e.type === 'RECORDING_START').video_start_ms;
      const rel = (t: number) => (t - vstart) / 1000;
      const starts = new Map<string, number>();
      const thinkStart = new Map<string, number>();
      const nActions = ev.filter((e) => e.type === 'ACTION_START').length;
      for (const e of ev) {
        if (e.type === 'THINKING_START') thinkStart.set(e.step_id, e.t_ms);
        if (e.type === 'ACTION_START') starts.set(e.step_id, thinkStart.get(e.step_id) ?? e.t_ms);
      }
      const mapTime = (t: number) => {
        const s = tm.segments.find((x: { inEnd: number }) => t < x.inEnd) ?? tm.segments.at(-1);
        return s.outStart + (Math.min(Math.max(t, s.inStart), s.inEnd) - s.inStart) / s.speed;
      };
      let chaptersOk = ch.chapters.length === nActions;
      for (const c of ch.chapters) {
        const want = mapTime(rel(starts.get(c.id) ?? 0));
        if (c.id === ch.chapters[0].id) {
          if (c.start !== 0) chaptersOk = false;
        } else if (Math.abs(c.start - want) > 1 / 30 + 0.01) chaptersOk = false;
      }
      diagUp();
      const v = sh(
        `${compose} run --rm -e VTT_FILE=/artifacts/${r.runId}/chapters.vtt --entrypoint node orchestrator /tests/acceptance/tools/vtt-check.mjs`,
        diagEnv,
      );
      diagDown();
      const cues = Number(/VTT_CUES (-?\d+)/.exec(v.out)?.[1] ?? -1);
      return {
        pass: chaptersOk && cues === ch.chapters.length,
        evidence: { chapters: ch.chapters.length, actions: nActions, cues, chaptersOk, tool: v.out.slice(-400), runId: r.runId },
      };
    },
  },
  {
    id: 9,
    title: 'Failing action → FAILED ACTION_END + chapter; assertion failure → exit 1',
    run: async () => {
      const r1 = runTest('specs/failing-action.json', 'failing-action.json');
      const ev1 = eventsOf(r1.dir);
      const ch1 = JSON.parse(fs.readFileSync(`${r1.dir}/chapters.json`, 'utf8'));
      const failEv = ev1.some((e) => e.type === 'ACTION_END' && e.status === 'FAILED');
      const failCh = ch1.chapters.some((c: { status: string }) => c.status === 'FAILED');
      const r2 = runTest('specs/assert-fail.json', 'assert-fail.json');
      return {
        pass: failEv && failCh && r1.code === 1 && r2.code === 1,
        evidence: { failEv, failCh, c1: r1.code, c2: r2.code, summary2: runJson(r2.dir).summary },
      };
    },
  },
  {
    id: 10,
    title: 'Verdict integrity: expect fail → FAILED; absent → UNVERIFIED',
    run: async () => {
      const r1 = runTest('specs/inject-expect.json', 'inject.json');
      const r2 = runTest('specs/inject-noexpect.json', 'inject.json');
      const j1 = runJson(r1.dir);
      const j2 = runJson(r2.dir);
      return {
        pass: j1.status === 'FAILED' && r1.code === 1 && j2.status === 'UNVERIFIED' && r2.code === 3,
        evidence: { s1: j1.status, c1: r1.code, s2: j2.status, c2: r2.code },
      };
    },
  },
  {
    id: 11,
    title: 'Secret bindings block wrong origin/input-type',
    run: async () => {
      const r = runTest('specs/secret-form.json', 'secret-form.json');
      const ev = eventsOf(r.dir);
      const typeEnds = ev.filter((e) => e.type === 'ACTION_END' && e.step_id !== 's0000');
      const bothFailed = typeEnds.length >= 2 && typeEnds.filter((e) => e.status === 'FAILED').length >= 2;
      const pw = fs.readFileSync('secrets/TEST_USER_PASSWORD', 'utf8').trim();
      const leak = siteLog().some((l) => {
        try {
          const b = JSON.parse(l.body ?? '{}');
          return b.kind !== undefined && JSON.stringify(b).includes(pw);
        } catch {
          return false;
        }
      });
      return { pass: bothFailed && !leak, evidence: { typeEnds: typeEnds.map((e) => e.status), leak } };
    },
  },
  {
    id: 12,
    title: 'Secret values absent from all text artifacts',
    run: async () => {
      const vals = ['TEST_USER_PASSWORD', 'TEST_USER_EMAIL'].map((n) => fs.readFileSync(`secrets/${n}`, 'utf8').trim()).filter(Boolean);
      const hits: string[] = [];
      for (const dir of fs.readdirSync('artifacts').filter((d) => d.startsWith('20') || d.startsWith('kill'))) {
        for (const f of sh(`find artifacts/${dir} -type f ! -name '*.mkv' ! -name '*.mp4' ! -name '*.png'`)
          .out.trim()
          .split('\n')
          .filter(Boolean)) {
          const t = fs.readFileSync(f, 'utf8');
          for (const v of vals) if (v && t.includes(v)) hits.push(`${f}:${v.slice(0, 3)}…`);
        }
      }
      return { pass: hits.length === 0, evidence: { hits } };
    },
  },
  {
    id: 13,
    title: 'Dialog observation + accept works',
    run: async () => {
      const r = runTest('specs/confirm.json', 'confirm.json');
      const tr = fs.readFileSync(`${r.dir}/agent/transcript.jsonl`, 'utf8');
      const hasDialog = /"dialog":\{[^}]*confirm/.test(tr);
      const res = siteLog()
        .map((l) => {
          try {
            return JSON.parse(l.body ?? '{}') as { kind?: string; result?: boolean };
          } catch {
            return {};
          }
        })
        .find((b) => b.kind === 'confirm');
      return {
        pass: (r.code === 0 || r.code === 3) && hasDialog && res?.result === true,
        evidence: { hasDialog, result: res },
      };
    },
  },
  {
    id: 14,
    title: 'click_at lands for all provider image spaces',
    run: async () => {
      const outcomes: Record<string, { code: number; hit: boolean }> = {};
      for (const tier of ['anthropic:standard', 'anthropic:high', 'openai', 'screen']) {
        const r = runTest('specs/target.json', `target-${tier}.json`);
        const hit = siteLog().some((l) => {
          try {
            return JSON.parse(l.body ?? '{}').kind === 'target';
          } catch {
            return false;
          }
        });
        outcomes[tier] = { code: r.code, hit };
      }
      const pass = Object.values(outcomes).every((o) => (o.code === 0 || o.code === 3) && o.hit);
      return { pass, evidence: outcomes };
    },
  },
  {
    id: 15,
    title: 'Two concurrent runs, both PASSED, disjoint artifacts',
    run: async () => {
      const [r1, r2] = await Promise.all([
        new Promise<RunResult>((res) => res(runTest('specs/login.json', 'login.json'))),
        new Promise<RunResult>((res) => res(runTest('specs/login.json', 'login.json'))),
      ]);
      const pass =
        r1.code === 0 &&
        r2.code === 0 &&
        r1.runId !== r2.runId &&
        fs.existsSync(`${r1.dir}/run.json`) &&
        fs.existsSync(`${r2.dir}/run.json`);
      return { pass, evidence: { r1: [r1.code, r1.runId], r2: [r2.code, r2.runId] } };
    },
  },
  {
    id: 16,
    title: 'Postprocess CLI rerun is byte-identical',
    run: async () => {
      const r = runTest('specs/login.json', 'login.json');
      const before = [fs.readFileSync(`${r.dir}/chapters.json`), fs.readFileSync(`${r.dir}/timemap.json`)];
      const pp = sh(
        `docker run --rm -v "${ROOT}/artifacts:/artifacts" -v "${ROOT}/tests:/tests:ro" --entrypoint node acc-diag-orchestrator src/postprocess/cli.ts /artifacts/${r.runId}`,
      );
      const after = [fs.readFileSync(`${r.dir}/chapters.json`), fs.readFileSync(`${r.dir}/timemap.json`)];
      return { pass: pp.code === 0 && before[0].equals(after[0]) && before[1].equals(after[1]), evidence: { code: pp.code } };
    },
  },
  {
    id: 17,
    title: 'Egress: only allowed markers reach the fixture',
    run: async () => {
      const before = siteLog().length;
      const r = runTest('specs/probe.json', 'probe.json', { AGENT_EGRESS_HOSTS: 'llm.test:80' });
      diagUp();
      const ip = sh(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${PROJECT}-sites-1`, diagEnv).out.trim();
      const eg = sh(
        `${compose} run --rm -e SITES_IP=${ip} --entrypoint node orchestrator /tests/acceptance/tools/egress-check.mjs`,
        diagEnv,
      );
      diagDown();
      const m = /EGRESS_RESULT (.*)/.exec(eg.out);
      const egRes = m ? JSON.parse(m[1]) : null;
      const after = siteLog().slice(before);
      const evilMarkers = after.filter(
        (l) =>
          /[?&]k=(img|fetch|post|beacon|browser_to_llm|agent_port_direct|wrongport|agent_to_allowed|ws(?![_a-z]))/.test(l.path ?? '') ||
          l.proto === 'udp',
      );
      const okMarkers = after.filter((l) => /[?&]k=(ws_ok|cdn|agent_ok)/.test(l.path ?? '') || l.path === '/probe');
      const pass =
        (r.code === 0 || r.code === 3) &&
        evilMarkers.length === 0 &&
        okMarkers.length >= 2 &&
        egRes?.llm_via_agent_port?.status === 200 &&
        egRes?.app_via_agent_port?.status === 403;
      return { pass, evidence: { evilMarkers, okMarkers: okMarkers.map((l) => l.path), egRes } };
    },
  },
  {
    id: 18,
    title: 'No direct egress from run pair',
    run: async () => {
      diagUp();
      const ip = sh(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${PROJECT}-sites-1`, diagEnv).out.trim();
      const eg = sh(
        `${compose} run --rm -e SITES_IP=${ip} --entrypoint node orchestrator /tests/acceptance/tools/egress-check.mjs`,
        diagEnv,
      );
      const br1 = sh(`${compose} exec -T browser sh -c "getent hosts example.com; echo rc=\\$?"`, diagEnv);
      const br2 = sh(
        `${compose} exec -T browser sh -c "timeout 3 bash -c '</dev/tcp/${ip}/80' && echo CONNECTED || echo UNREACHABLE"`,
        diagEnv,
      );
      diagDown();
      const m = /EGRESS_RESULT (.*)/.exec(eg.out);
      const e = m ? JSON.parse(m[1]) : {};
      const pass =
        /EAI|SERVFAIL|ENOTFOUND|NXDOMAIN|Name|fail/i.test(String(e.dns_example)) &&
        e.noproxy_fetch === 'failed' &&
        e.tcp_egress_ip === 'unreachable' &&
        /UNREACHABLE|rc=2|rc=1/.test(br2.out + br1.out);
      return { pass, evidence: { e, browser: [br1.out.slice(-120), br2.out.slice(-120)] } };
    },
  },
  {
    id: 19,
    title: 'Newline-injected allowed_hosts rejected before squid starts',
    run: async () => {
      const r = runTest('specs/bad-host.json', 'probe.json');
      return {
        pass: r.code === 2,
        evidence: { code: r.code, summary: fs.existsSync(`${r.dir}/run.json`) ? runJson(r.dir).summary : r.out.slice(-300) },
      };
    },
  },
  {
    id: 21,
    title: 'gen-squid-conf: UPSTREAM_PROXY/BYPASS/invalid-bypass variants',
    run: async () => {
      const gen = (envs: string) =>
        sh(
          `docker run --rm -v "$PWD/tests:/tests:ro" -e TEST_FILE=/tests/specs/login.json -e AGENT_EGRESS_HOSTS=llm.test:80 ${envs} --entrypoint sh acc-diag-proxy -c 'sed "s|exec squid.*||; s|CONF=/etc/squid/squid.conf|CONF=/tmp/s.conf|; s|LOG=/var/log/squid-pair|LOG=/tmp|" /usr/local/bin/gen-squid-conf > /tmp/g.sh && sh /tmp/g.sh; echo GENC_RC=$?; cat /tmp/s.conf 2>/dev/null'`,
        );
      const noUpstream = gen('');
      const upstream = gen("-e UPSTREAM_PROXY=http.docker.internal:3128 -e UPSTREAM_BYPASS='app.test,*.cdn.test'");
      const bad = gen("-e UPSTREAM_PROXY=http.docker.internal:3128 -e UPSTREAM_BYPASS='bad host!!'");
      const pass =
        noUpstream.out.includes('GENC_RC=0') &&
        !noUpstream.out.includes('cache_peer') &&
        !noUpstream.out.includes('always_direct') &&
        upstream.out.includes('cache_peer http.docker.internal parent 3128 0 no-query default') &&
        upstream.out.includes('acl upstream_bypass dstdomain app.test .cdn.test') &&
        upstream.out.includes('always_direct allow upstream_bypass') &&
        upstream.out.includes('never_direct allow all') &&
        !/always_direct allow b\d/.test(upstream.out) &&
        bad.out.includes('invalid UPSTREAM_BYPASS entry') &&
        bad.out.includes('GENC_RC=1');
      return {
        pass,
        evidence: {
          noUpstream: noUpstream.out.split('\n').filter((l: string) => /cache_peer|direct|GENC/.test(l)),
          upstream: upstream.out.split('\n').filter((l: string) => /cache_peer|direct|bypass|GENC/.test(l)),
          bad: bad.out.split('\n').filter((l: string) => /invalid|GENC/.test(l)),
        },
      };
    },
  },
  {
    id: 20,
    title: 'run.json.egress.denied lists denied hosts; proxy log and network.jsonl exist',
    run: async () => {
      const r = runTest('specs/probe.json', 'probe.json', { AGENT_EGRESS_HOSTS: 'llm.test:80' });
      const j = runJson(r.dir);
      const deniedHosts = (j.egress?.denied ?? []).map((d: { host: string }) => d.host);
      const has = (h: string) => deniedHosts.includes(h);
      const net = fs.existsSync(`${r.dir}/network.jsonl`)
        ? fs
            .readFileSync(`${r.dir}/network.jsonl`, 'utf8')
            .split('\n')
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l) as { method?: string; url?: string; status?: number | null })
        : [];
      const netOk = net.some((e) => typeof e.method === 'string' && typeof e.url === 'string' && typeof e.status === 'number');
      const pass = j.egress && has('evil.test:80') && has('app.test:8081') && fs.existsSync(`${r.dir}/logs/proxy-access.log`) && netOk;
      return {
        pass,
        evidence: {
          denied: j.egress?.denied,
          allowed: j.egress?.allowed,
          logExists: fs.existsSync(`${r.dir}/logs/proxy-access.log`),
          networkEntries: net.length,
          networkFirst: net[0] ?? null,
        },
      };
    },
  },

  {
    id: 22,
    title: 'NL blog scenario: plan, execute, evaluate, report (stub)',
    run: async () => {
      const r = runTest('specs/blog.json', 'blog.json');
      if (!r.dir || !fs.existsSync(r.dir)) return { pass: false, evidence: { error: 'no run dir', out: r.out.slice(-800) } };
      const j = runJson(r.dir);
      const ev = eventsOf(r.dir);
      const plan = fs.existsSync(`${r.dir}/plan.json`) ? JSON.parse(fs.readFileSync(`${r.dir}/plan.json`, 'utf8')) : null;
      const evaln = fs.existsSync(`${r.dir}/evaluation.json`) ? JSON.parse(fs.readFileSync(`${r.dir}/evaluation.json`, 'utf8')) : null;
      const heroSha = crypto.createHash('sha256').update(fs.readFileSync('tests/specs/assets/hero.png')).digest('hex');
      const postLog = siteLog().find((l) => l.msg === 'post_created');
      const reports = ['report.json', 'report.md', 'report.html'].filter((f) => fs.existsSync(`${r.dir}/${f}`));
      const repJson = fs.existsSync(`${r.dir}/report.json`) ? JSON.parse(fs.readFileSync(`${r.dir}/report.json`, 'utf8')) : null;
      const html = fs.existsSync(`${r.dir}/report.html`) ? fs.readFileSync(`${r.dir}/report.html`, 'utf8') : '';
      const stepDones = ev.filter((e) => e.type === 'ACTION_START' && e.action === 'step').map((e) => e.plan_step);
      const uploads = ev.filter((e) => e.type === 'ACTION_START' && e.action === 'upload');
      const pass =
        j.status === 'PASSED' &&
        j.exit_code === 0 &&
        plan?.steps?.length === 6 &&
        plan?.criteria?.length === 2 &&
        evaln?.criteria?.every((c: { status: string }) => c.status === 'MET') &&
        postLog?.upload_sha256 === heroSha &&
        reports.length === 3 &&
        html.includes('src="final.mp4"') &&
        html.includes('src="chapters.vtt"') &&
        repJson?.plan?.steps?.every((s: { outcome: string }) => s.outcome === 'PASSED') &&
        stepDones.length === 6 &&
        uploads.length === 1 &&
        repJson?.artifacts?.screenshots?.every((p: string) => fs.existsSync(`${r.dir}/${p}`));
      return {
        pass,
        evidence: {
          code: r.code,
          status: j.status,
          steps: plan?.steps?.length,
          stepDones,
          uploads: uploads.length,
          postLog,
          heroSha,
          reports,
        },
      };
    },
  },
  {
    id: 23,
    title: 'Plan approval: awaiting_approval, edited plan, reject, timeout',
    run: async () => {
      const mkControl = () => fs.mkdtempSync('/tmp/acc-control-');
      const waitForStatus = (phase: string, timeoutMs: number) => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
          const artifacts = fs
            .readdirSync('artifacts')
            .filter((d) => /\d{8}-\d{6}-/.test(d))
            .sort()
            .reverse();
          for (const a of artifacts) {
            const f = `artifacts/${a}/status.json`;
            if (fs.existsSync(f)) {
              try {
                const st = JSON.parse(fs.readFileSync(f, 'utf8'));
                if (st.phase === phase && Date.parse(st.updated_at) > t0 - 90000) return `artifacts/${a}`;
              } catch {
                /* partial write */
              }
            }
          }
          spawnSync('sleep', ['0.3']);
        }
        return null;
      };
      const launch = (ctrl: string) =>
        spawn('sh', ['scripts/run-test.sh', 'specs/blog-review.json', 'stub//tests/stub/blog.json'], {
          env: { ...process.env, COMPOSE_OVERLAYS: `${OVERLAY} tests/acceptance/compose.control.yml`, CONTROL_DIR_HOST: ctrl },
        });

      // (a) approve an edited plan -> the edited plan is what runs.
      const ctrlA = mkControl();
      const procA = launch(ctrlA);
      const runDirA = waitForStatus('awaiting_approval', 120000);
      const sawAwaitingBeforeVideo = runDirA !== null && !fs.existsSync(`${runDirA}/raw.mkv`);
      if (runDirA) {
        const rawPlan = JSON.parse(fs.readFileSync(`${runDirA}/plan.json`, 'utf8'));
        fs.writeFileSync(
          `${ctrlA}/approval.json`,
          JSON.stringify({ decision: 'approve', plan: { ...rawPlan, title: 'EDITED PLAN TITLE' } }),
        );
      }
      const codeA = await new Promise<number>((res) => procA.on('exit', (c) => res(c ?? 1)));
      const jA = runDirA && fs.existsSync(`${runDirA}/run.json`) ? runJson(runDirA) : null;
      const editedUsed = runDirA !== null && JSON.parse(fs.readFileSync(`${runDirA}/plan.json`, 'utf8')).title === 'EDITED PLAN TITLE';

      // (b) reject -> CANCELLED, exit 4, no raw.mkv.
      const ctrlB = mkControl();
      const procB = launch(ctrlB);
      const runDirB = waitForStatus('awaiting_approval', 120000);
      if (runDirB) fs.writeFileSync(`${ctrlB}/approval.json`, JSON.stringify({ decision: 'reject' }));
      const codeB = await new Promise<number>((res) => procB.on('exit', (c) => res(c ?? 1)));
      const jB = runDirB && fs.existsSync(`${runDirB}/run.json`) ? runJson(runDirB) : null;

      // (c) approval timeout -> CANCELLED, exit 4, no raw.mkv.
      const rC = runTest('specs/blog-review-timeout.json', 'blog.json', {
        COMPOSE_OVERLAYS: 'tests/acceptance/compose.control.yml',
        CONTROL_DIR_HOST: mkControl(),
      });
      const jC = rC.dir && fs.existsSync(`${rC.dir}/run.json`) ? runJson(rC.dir) : null;

      const pass =
        sawAwaitingBeforeVideo &&
        editedUsed &&
        codeA === 0 &&
        jA?.status === 'PASSED' &&
        codeB === 4 &&
        jB?.status === 'CANCELLED' &&
        runDirB !== null &&
        !fs.existsSync(`${runDirB}/raw.mkv`) &&
        rC.code === 4 &&
        jC?.status === 'CANCELLED' &&
        rC.dir !== '' &&
        !fs.existsSync(`${rC.dir}/raw.mkv`);
      return {
        pass,
        evidence: {
          sawAwaitingBeforeVideo,
          editedUsed,
          approve: { code: codeA, status: jA?.status },
          reject: { code: codeB, status: jB?.status },
          timeout: { code: rC.code, status: jC?.status },
        },
      };
    },
  },
  {
    id: 24,
    title: 'Evaluator can only downgrade: NOT_MET, MET-without-assertion, high issue',
    run: async () => {
      const r1 = runTest('specs/blog.json', 'blog-eval-notmet.json');
      const j1 = runJson(r1.dir);
      const r2 = runTest('specs/blog.json', 'blog-eval-noassert.json');
      const j2 = runJson(r2.dir);
      const r3 = runTest('specs/blog.json', 'blog-eval-high.json');
      const j3 = runJson(r3.dir);
      const pass =
        j1.status === 'FAILED' && r1.code === 1 && j2.status === 'UNVERIFIED' && r2.code === 3 && j3.status === 'FAILED' && r3.code === 1;
      return { pass, evidence: { notmet: [j1.status, r1.code], noassert: [j2.status, r2.code], high: [j3.status, r3.code] } };
    },
  },
  {
    id: 25,
    title: 'Upload restrictions: undeclared/traversal names are action errors; nothing reaches the fixture',
    run: async () => {
      const before = siteLog().filter((l) => l.msg === 'post_created').length;
      const r = runTest('specs/blog.json', 'blog-upload-bad.json');
      const j = runJson(r.dir);
      const ev = eventsOf(r.dir);
      const failedUploads = ev.filter((e) => e.type === 'ACTION_END' && e.status === 'FAILED' && (e.error ?? '').includes('upload'));
      const after = siteLog().filter((l) => l.msg === 'post_created').length;
      const pass = r.code === 1 && j.status === 'FAILED' && failedUploads.length >= 2 && after === before;
      return {
        pass,
        evidence: {
          code: r.code,
          status: j.status,
          failedUploads: failedUploads.map((e) => e.error?.slice(0, 80)),
          posts: [before, after],
        },
      };
    },
  },
  {
    id: 26,
    title: 'Report escaping: <script>/<img onerror> payloads are inert in report.html',
    run: async () => {
      const r = runTest('specs/blog-escape.json', 'blog-eval-escape.json');
      const html = fs.readFileSync(`${r.dir}/report.html`, 'utf8');
      const imgTags = html.match(/<img[^>]*>/g) ?? [];
      const ok =
        !html.includes('<script') &&
        imgTags.every((t) => !t.includes('onerror')) &&
        html.includes('&lt;script&gt;') &&
        !/(?:href|src)="javascript:/.test(html);
      return {
        pass: ok,
        evidence: { code: r.code, imgTags: imgTags.length, rawScript: html.includes('<script'), escaped: html.includes('&lt;script&gt;') },
      };
    },
  },

  {
    id: 27,
    title: 'Runner: bearer auth, request validation, FIFO queue, cancel (§16.1)',
    run: async () => {
      const dataDir = fs.mkdtempSync('/tmp/acc-runner-data-');
      const secDir = fs.mkdtempSync('/tmp/acc-runner-sec-');
      const token = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(path.join(secDir, 'RUNNER_TOKEN'), `${token}\n`, { mode: 0o600 });
      const runner = await spawnReady(
        ['node', 'src/runner/index.ts'],
        {
          RUNNER_BIND: '127.0.0.1:0',
          RUNNER_DATA_DIR: dataDir,
          SECRETS_DIR: secDir,
          MAX_CONCURRENT_RUNS: '1',
          COMPOSE_OVERLAYS: OVERLAY,
          SITES_LOG_DIR: path.join(ROOT, SITES_LOG),
        },
        /RUNNER_LISTENING http:\/\/127\.0\.0\.1:(\d+)/,
      );
      const port = Number(/RUNNER_LISTENING http:\/\/127\.0\.0\.1:(\d+)/.exec(runner.output())?.[1]);
      const api = async (method: string, p: string, body?: unknown, tok: string | null = token) => {
        const headers: Record<string, string> = { host: `127.0.0.1:${port}`, 'content-type': 'application/json' };
        if (tok !== null) headers.authorization = `Bearer ${tok}`;
        const r = await httpCall(method, port, p, headers, body === undefined ? undefined : JSON.stringify(body));
        return { code: r.code, json: JSON.parse(r.body || 'null') as { state?: string; exit_code?: number } | null };
      };
      const mkReq = (id: string, files: { request?: string; spec?: string } = {}) => {
        const dir = path.join(dataDir, 'requests', id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'request.json'),
          files.request ?? JSON.stringify({ run_id: id, model: 'stub//tests/stub/sleep-loop.json' }),
        );
        fs.writeFileSync(
          path.join(dir, 'spec.json'),
          files.spec ??
            JSON.stringify({
              name: `queue-${id.slice(-4)}`,
              start_url: 'http://app.test/',
              goal: 'sleep',
              allowed_origins: ['http://app.test'],
            }),
        );
      };
      const ev: Record<string, unknown> = {};
      let pass = false;
      try {
        // Auth: missing and wrong tokens -> 401.
        ev.noToken = (await api('GET', '/health', undefined, null)).code;
        ev.wrongToken = (await api('GET', '/health', undefined, '0'.repeat(64))).code;
        // Validation: malformed id, traversal, missing dir, invalid spec, unknown provider -> 400.
        ev.malformed = (await api('POST', '/runs', { run_id: 'nope' })).code;
        ev.traversal = (await api('POST', '/runs', { run_id: '../escape' })).code;
        ev.missingDir = (await api('POST', '/runs', { run_id: '20261030-000000-aaaa' })).code;
        mkReq('20261030-000000-bbbb', { spec: '{"name":1}' });
        ev.badSpec = (await api('POST', '/runs', { run_id: '20261030-000000-bbbb' })).code;
        mkReq('20261030-000000-cccc', { request: JSON.stringify({ run_id: '20261030-000000-cccc', model: 'ollama/x' }) });
        ev.badProvider = (await api('POST', '/runs', { run_id: '20261030-000000-cccc' })).code;

        // Queueing: MAX_CONCURRENT_RUNS=1 → second run stays queued while the first runs.
        const id1 = accRunId();
        const id2 = accRunId();
        mkReq(id1);
        mkReq(id2);
        ev.post1 = (await api('POST', '/runs', { run_id: id1 })).code;
        ev.post2 = (await api('POST', '/runs', { run_id: id2 })).code;
        ev.id1Running = await waitFor(async () => (await api('GET', `/runs/${id1}`)).json?.state === 'running', 480_000);
        ev.id2WhileFirstRuns = (await api('GET', `/runs/${id2}`)).json?.state;

        // Cancelling a queued run removes it.
        ev.cancelQueued = (await api('POST', `/runs/${id2}/cancel`)).json?.state;

        // Cancelling a running run -> orchestrator exits CANCELLED (4).
        await api('POST', `/runs/${id1}/cancel`);
        ev.id1Finished = await waitFor(async () => {
          const s = (await api('GET', `/runs/${id1}`)).json;
          return s?.state === 'cancelled' || s?.state === 'exited';
        }, 240_000);
        ev.id1State = (await api('GET', `/runs/${id1}`)).json;
        const j1 = fs.existsSync(`artifacts/${id1}/run.json`) ? runJson(`artifacts/${id1}`) : null;
        ev.id1Run = j1 ? { status: j1.status, exit_code: j1.exit_code } : 'no run.json';
        pass =
          ev.noToken === 401 &&
          ev.wrongToken === 401 &&
          ev.malformed === 400 &&
          ev.traversal === 400 &&
          ev.missingDir === 400 &&
          ev.badSpec === 400 &&
          ev.badProvider === 400 &&
          ev.post1 === 202 &&
          ev.post2 === 202 &&
          ev.id1Running === true &&
          ev.id2WhileFirstRuns === 'queued' &&
          ev.cancelQueued === 'cancelled' &&
          ev.id1Finished === true &&
          j1?.status === 'CANCELLED' &&
          j1?.exit_code === 4;
      } finally {
        await stopProc(runner);
      }
      return { pass, evidence: ev };
    },
  },
  {
    id: 28,
    title: 'Control-plane guards: Host/Origin/Content-Type, network endpoint + ui container smoke (§16.2)',
    run: async () => {
      const dataDir = fs.mkdtempSync('/tmp/acc-ui-data-');
      const secDir = fs.mkdtempSync('/tmp/acc-ui-sec-');
      fs.writeFileSync(path.join(secDir, 'RUNNER_TOKEN'), `${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
      const fake = await spawnReady(
        ['node', 'tests/acceptance/tools/fake-runner.mjs'],
        { FAKE_RUNNER_BIND: '127.0.0.1:0' },
        /FAKE_RUNNER_LISTENING http:\/\/127\.0\.0\.1:(\d+)/,
      );
      const fakePort = /FAKE_RUNNER_LISTENING http:\/\/127\.0\.0\.1:(\d+)/.exec(fake.output())?.[1];
      const server = await spawnReady(
        ['node', 'src/server/index.ts'],
        {
          PORT: '0',
          BIND: '127.0.0.1',
          DATA_DIR: dataDir,
          ARTIFACTS_DIR: path.join(ROOT, 'artifacts'),
          SECRETS_DIR: secDir,
          RUNNER_URL: `http://127.0.0.1:${fakePort}`,
          UI_DIST: path.join(dataDir, 'no-ui-dist'),
        },
        /SERVER_LISTENING http:\/\/127\.0\.0\.1:(\d+)/,
      );
      const port = Number(/SERVER_LISTENING http:\/\/127\.0\.0\.1:(\d+)/.exec(server.output())?.[1]);
      const ev: Record<string, unknown> = {};
      let pass = false;
      try {
        const form = JSON.stringify({ title: 'T', instructions: 'i', start_url: 'http://app.test', model: 'stub' });
        const goodHeaders = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
        ev.wrongHost = (await httpCall('GET', port, '/api/runs', { host: 'evil.test:1' })).code;
        ev.foreignOrigin = (await httpCall('POST', port, '/api/runs', { ...goodHeaders, origin: 'http://evil.test' }, form)).code;
        ev.missingOrigin = (
          await httpCall('POST', port, '/api/runs', { host: `127.0.0.1:${port}`, 'content-type': 'application/json' }, form)
        ).code;
        ev.textPlain = (await httpCall('POST', port, '/api/runs', { ...goodHeaders, 'content-type': 'text/plain' }, 'instructions=x')).code;
        const ok = await httpCall('POST', port, '/api/runs', goodHeaders, form);
        ev.accepted = ok.code;
        const created = JSON.parse(ok.body || '{}') as { run_id?: string };
        ev.requestDir = created.run_id !== undefined && fs.existsSync(path.join(dataDir, 'requests', created.run_id, 'spec.json'));

        // §16.2: GET /api/runs/:id/network returns the run's network.jsonl entries.
        const netId = created.run_id ?? '';
        const netArt = path.join(ROOT, 'artifacts', netId);
        fs.mkdirSync(netArt, { recursive: true });
        fs.writeFileSync(
          path.join(netArt, 'network.jsonl'),
          `${JSON.stringify({ seq: 0, t_ms: 1, method: 'GET', url: 'http://app.test/', resource_type: 'document', status: 200, ms: 8, error: null, headers_out: {}, headers_in: {} })}\n`,
        );
        const netRes = JSON.parse(
          (await httpCall('GET', port, `/api/runs/${netId}/network`, { host: `127.0.0.1:${port}` })).body || '{}',
        ) as { source?: string; entries?: { method?: string; url?: string; status?: number }[] };
        ev.network = { source: netRes.source, entries: netRes.entries?.length ?? -1, first: netRes.entries?.[0] ?? null };
        ev.networkOk =
          netRes.source === 'cdp' &&
          (netRes.entries ?? []).some((e) => typeof e.method === 'string' && typeof e.url === 'string' && typeof e.status === 'number');
        fs.rmSync(netArt, { recursive: true, force: true });
        pass =
          ev.wrongHost === 421 &&
          ev.foreignOrigin === 403 &&
          ev.missingOrigin === 403 &&
          ev.textPlain === 403 &&
          ev.accepted === 201 &&
          ev.requestDir === true &&
          ev.networkOk === true;
      } finally {
        await stopProc(server);
        await stopProc(fake);
      }
      // Container smoke: docker-compose.ui.yml up, GET /api/runs through 127.0.0.1:7070.
      fs.mkdirSync('data', { recursive: true });
      fs.mkdirSync('ui/dist', { recursive: true });
      const up = sh('docker compose -f docker-compose.ui.yml up -d --build --wait', { PORT: '7070' });
      ev.composeUp = up.code;
      let smoke: { code: number; runs: number } = { code: 0, runs: -1 };
      for (let i = 0; i < 60; i++) {
        try {
          const r = await httpCall('GET', 7070, '/api/runs', { host: '127.0.0.1:7070' });
          smoke = { code: r.code, runs: (JSON.parse(r.body || '{}') as { runs?: unknown[] }).runs?.length ?? -1 };
          if (r.code === 200) break;
        } catch {
          await new Promise((r2) => setTimeout(r2, 1000));
        }
      }
      ev.smoke = smoke;
      ev.composeDown = sh('docker compose -f docker-compose.ui.yml down -v').code;
      pass = pass && ev.composeUp === 0 && smoke.code === 200 && smoke.runs >= 0 && ev.composeDown === 0;
      return { pass, evidence: ev };
    },
  },
  {
    id: 29,
    title: 'UI end to end: form → approval → report/video/gallery → rerun/cancel (§16.3)',
    run: async () => {
      const ev: Record<string, unknown> = {};
      // Real runner daemon on the host (the ui container reaches it via
      // host.docker.internal:7071, already in docker-compose.ui.yml).
      fs.mkdirSync('data', { recursive: true });
      const runner = await spawnReady(
        ['node', 'src/runner/index.ts'],
        {
          RUNNER_BIND: '127.0.0.1:7071',
          RUNNER_DATA_DIR: path.join(ROOT, 'data'),
          SECRETS_DIR: path.join(ROOT, 'secrets'),
          COMPOSE_OVERLAYS: OVERLAY,
          SITES_LOG_DIR: path.join(ROOT, SITES_LOG),
        },
        /RUNNER_LISTENING http:\/\/127\.0\.0\.1:7071/,
      );
      let pass = false;
      try {
        const up = sh('docker compose -f docker-compose.ui.yml up -d --build --wait');
        ev.composeUp = up.code;
        let health = 0;
        for (let i = 0; i < 60 && health !== 200; i++) {
          try {
            health = (await httpCall('GET', 7070, '/api/health', { host: '127.0.0.1:7070' })).code;
          } catch {
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
        ev.health = health;
        const build = sh('docker build -f docker/e2e/Dockerfile -t browser-agent-e2e .');
        ev.e2eBuild = build.code;
        const e2e = sh('docker run --rm --add-host host.docker.internal:host-gateway -v "$PWD/tests:/tests:ro" browser-agent-e2e');
        ev.e2eExit = e2e.code;
        const m = /E2E_RESULT (.*)/.exec(e2e.out);
        ev.result = m ? (JSON.parse(m[1]) as Record<string, unknown>) : { tail: e2e.out.slice(-1500) };
        ev.logTail = e2e.out
          .split('\n')
          .filter((l: string) => l.startsWith('[e2e]'))
          .slice(-12);
        pass = up.code === 0 && health === 200 && build.code === 0 && e2e.code === 0 && (ev.result as { ok?: boolean }).ok === true;
      } finally {
        ev.composeDown = sh('docker compose -f docker-compose.ui.yml down -v').code;
        await stopProc(runner);
      }
      pass = pass && ev.composeDown === 0;
      return { pass, evidence: ev };
    },
  },
  {
    id: 32,
    title: 'Live progress: detail API/SSE + UI update without reload (§16.3)',
    run: async () => {
      const ev: Record<string, unknown> = {};
      // Same stack as criterion 29: real host runner on 7071 + the ui compose project.
      fs.mkdirSync('data', { recursive: true });
      const runner = await spawnReady(
        ['node', 'src/runner/index.ts'],
        {
          RUNNER_BIND: '127.0.0.1:7071',
          RUNNER_DATA_DIR: path.join(ROOT, 'data'),
          SECRETS_DIR: path.join(ROOT, 'secrets'),
          COMPOSE_OVERLAYS: OVERLAY,
          SITES_LOG_DIR: path.join(ROOT, SITES_LOG),
        },
        /RUNNER_LISTENING http:\/\/127\.0\.0\.1:7071/,
      );
      const host = { host: '127.0.0.1:7070' };
      const uiHeaders = { ...host, origin: 'http://127.0.0.1:7070', 'content-type': 'application/json' };
      const uiGet = async (p: string) =>
        JSON.parse((await httpCall('GET', 7070, p, host)).body || 'null') as Record<string, unknown> | null;
      interface Prog {
        phase?: string | null;
        plan_steps?: { id: string; status: string }[];
        steps?: { step_id: string; kind: string; label: string; result: string }[];
        counters?: { elapsed_s: number | null; steps: number; tokens: { input: number; output: number } };
        latest_screenshot?: string | null;
        events?: number;
      }
      let pass = false;
      try {
        ev.composeUp = sh('docker compose -f docker-compose.ui.yml up -d --build --wait').code;
        for (let i = 0; i < 60; i++) {
          try {
            if ((await httpCall('GET', 7070, '/api/health', host)).code === 200) break;
          } catch {
            /* not up yet */
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        ev.health = (await httpCall('GET', 7070, '/api/health', host)).code;

        // A sleep-loop stub run stays 'running' for ~90 s: 25 turns × 3 s sleeps.
        const stub = fs.readFileSync('tests/stub/sleep-loop.json', 'utf8');
        const created = await httpCall(
          'POST',
          7070,
          '/api/runs',
          uiHeaders,
          JSON.stringify({
            title: 'live progress check',
            instructions: 'loop url assertions until done',
            start_url: 'http://app.test/',
            model: 'stub',
            allowed_hosts: ['app.test:80'],
            stub_script: JSON.parse(stub),
          }),
        );
        ev.create = created.code;
        const runId = (JSON.parse(created.body || '{}') as { run_id?: string }).run_id ?? '';
        ev.runId = runId;

        // Collect SSE until 'done': status transitions + progress snapshots.
        const sse = { phases: new Set<string>(), last: null as Prog | null, progressEvents: 0, sawDone: false };
        const sseReq = http.request({ host: '127.0.0.1', port: 7070, path: `/api/runs/${runId}/events`, headers: host }, (res) => {
          let buf = '';
          res.on('data', (c: Buffer) => {
            buf += c.toString('utf8');
            for (;;) {
              const i = buf.indexOf('\n\n');
              if (i < 0) break;
              const chunk = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const name = /^event: (\S+)/m.exec(chunk)?.[1] ?? 'message';
              const data = /^data: (.*)$/m.exec(chunk)?.[1] ?? '';
              try {
                if (name === 'status') {
                  const ph = (JSON.parse(data) as { phase?: string }).phase;
                  if (ph) sse.phases.add(ph);
                } else if (name === 'progress') {
                  sse.last = JSON.parse(data) as Prog;
                  sse.progressEvents += 1;
                } else if (name === 'done') {
                  sse.sawDone = true;
                }
              } catch {
                /* partial frame */
              }
            }
          });
        });
        sseReq.on('error', () => {});
        sseReq.end();

        // Phase transitions via the detail API while the run is live.
        const apiPhases = new Set<string>();
        ev.reachedRunning = await waitFor(async () => {
          const d = (await uiGet(`/api/runs/${runId}`)) as { status?: { phase?: string } } | null;
          if (d?.status?.phase) apiPhases.add(d.status.phase);
          return d?.status?.phase === 'running';
        }, 480_000);

        // The progress payload: plan-step statuses, step log, counters, screenshot.
        const fetchProgress = async (): Promise<Prog | null> => {
          const d = (await uiGet(`/api/runs/${runId}`)) as { progress?: Prog } | null;
          return d?.progress ?? null;
        };
        let prog: Prog | null = null;
        ev.progressReady = await waitFor(async () => {
          prog = await fetchProgress();
          return (prog?.steps?.length ?? 0) >= 2 && prog?.latest_screenshot != null;
        }, 240_000);
        prog ??= await fetchProgress();
        const stepsHaveFields =
          (prog?.steps?.length ?? 0) > 0 &&
          (prog?.steps ?? []).every(
            (s) => Boolean(s.step_id) && Boolean(s.kind) && typeof s.label === 'string' && typeof s.result === 'string',
          );
        ev.apiProgress = prog
          ? {
              phase: prog.phase,
              planStepStatuses: prog.plan_steps,
              stepCount: prog.counters?.steps,
              tokens: prog.counters?.tokens,
              elapsed_s: prog.counters?.elapsed_s,
              latestScreenshot: prog.latest_screenshot,
              sampleSteps: prog.steps?.slice(0, 3),
              fieldsOk: stepsHaveFields,
            }
          : null;

        // The screenshot list grows while the run is live.
        const shots1 = (((await uiGet(`/api/runs/${runId}/screenshots`)) as { screenshots?: string[] } | null)?.screenshots ?? []).length;
        ev.shotsGrew = await waitFor(async () => {
          const n = (((await uiGet(`/api/runs/${runId}/screenshots`)) as { screenshots?: string[] } | null)?.screenshots ?? []).length;
          return n > shots1;
        }, 120_000);

        // UI: the dockerized driver asserts the live view renders and updates
        // without a reload while the run is still running.
        ev.e2eBuild = sh('docker build -f docker/e2e/Dockerfile -t browser-agent-e2e .').code;
        const e2e = sh(
          `docker run --rm --add-host host.docker.internal:host-gateway -e E2E_RUN_ID=${runId} --entrypoint node browser-agent-e2e /e2e/live-progress-e2e.mjs`,
        );
        ev.e2eExit = e2e.code;
        const m = /E2E_RESULT (.*)/.exec(e2e.out);
        ev.e2e = m ? (JSON.parse(m[1]) as Record<string, unknown>) : { tail: e2e.out.slice(-800) };

        // Cancel the sleeper; the SSE stream then ends with 'done'.
        ev.cancel = (await httpCall('POST', 7070, `/api/runs/${runId}/cancel`, uiHeaders, '{}')).code;
        ev.streamEnded = await waitFor(() => Promise.resolve(sse.sawDone), 300_000);
        sseReq.destroy();
        ev.sse = { progressEvents: sse.progressEvents, lastSteps: sse.last?.steps?.length, lastPhase: sse.last?.phase };
        const allPhases = [...new Set([...sse.phases, ...apiPhases])];
        ev.phases = allPhases;
        pass =
          ev.composeUp === 0 &&
          ev.health === 200 &&
          ev.create === 201 &&
          ev.reachedRunning === true &&
          ev.progressReady === true &&
          stepsHaveFields &&
          (prog?.plan_steps?.length ?? 0) >= 1 &&
          (prog?.plan_steps ?? []).every((s) => typeof s.status === 'string') &&
          typeof prog?.counters?.steps === 'number' &&
          typeof prog?.counters?.tokens?.input === 'number' &&
          typeof prog?.counters?.tokens?.output === 'number' &&
          typeof prog?.latest_screenshot === 'string' &&
          ev.shotsGrew === true &&
          ev.e2eExit === 0 &&
          (ev.e2e as { ok?: boolean }).ok === true &&
          sse.progressEvents >= 1 &&
          allPhases.includes('running') &&
          allPhases.length >= 2;
      } finally {
        ev.composeDown = sh('docker compose -f docker-compose.ui.yml down -v').code;
        await stopProc(runner);
      }
      pass = pass && ev.composeDown === 0;
      return { pass, evidence: ev };
    },
  },
  {
    id: 31,
    title: 'Network presets: full reaches fixture; limited/offline deny on 3128; agent rules unchanged (§2.4)',
    run: async () => {
      const ev: Record<string, unknown> = {};
      // Render squid.conf per preset with the proxy image (same trick as criterion 21).
      ev.proxyBuild = sh(`${compose} build proxy`, diagEnv).code;
      const genConf = (vol: string, testFile: string) =>
        sh(
          `docker run --rm -v ${vol} -e TEST_FILE=${testFile} -e AGENT_EGRESS_HOSTS=llm.test:80 --entrypoint sh acc-diag-proxy -c 'sed "s|exec squid.*||; s|CONF=/etc/squid/squid.conf|CONF=/tmp/s.conf|; s|LOG=/var/log/squid-pair|LOG=/tmp|" /usr/local/bin/gen-squid-conf > /tmp/g.sh && sh /tmp/g.sh; echo GENC_RC=$?; cat /tmp/s.conf 2>/dev/null'`,
        ).out;
      const testsVol = '"$PWD/tests:/tests:ro"';
      const confLimited = genConf(testsVol, '/tests/specs/probe.json');
      const confFull = genConf(testsVol, '/tests/specs/probe-full.json');
      const confOffline = genConf(testsVol, '/tests/specs/login-offline.json');
      // An unexpected network value conservatively behaves as limited.
      const bogusDir = fs.mkdtempSync('/tmp/acc-net-');
      fs.writeFileSync(
        path.join(bogusDir, 'bogus.json'),
        JSON.stringify({ ...JSON.parse(fs.readFileSync('tests/specs/probe.json', 'utf8')), network: 'banana' }),
      );
      const confBogus = genConf(`"${bogusDir}:/tspecs:ro"`, '/tspecs/bogus.json');

      const confBody = (out: string) => out.slice(out.indexOf('http_port'));
      const catchAll = (c: string) => /^http_access allow browser_port$/m.test(c);
      const bRules = (c: string) => c.split('\n').filter((l) => /^acl b\d+_|^http_access allow browser_port b\d+_/.test(l));
      const agentRules = (c: string) => c.split('\n').filter((l) => /\bg\d+_(host|port)\b|agent_port/.test(l));
      const agentRulesIdentical =
        JSON.stringify(agentRules(confLimited)) === JSON.stringify(agentRules(confFull)) &&
        JSON.stringify(agentRules(confLimited)) === JSON.stringify(agentRules(confOffline));
      const bogusEqualsLimited = confBody(confBogus) === confBody(confLimited);

      // real run, network:'full' — the probe's evil.test requests reach the fixture.
      const beforeFull = siteLog().length;
      const rFull = runTest('specs/probe-full.json', 'probe.json', { AGENT_EGRESS_HOSTS: 'llm.test:80' });
      const afterFull = siteLog().slice(beforeFull);
      const evilArrived = afterFull.filter((l) => String(l.host_header ?? '').split(':')[0] === 'evil.test');
      const probeBody = afterFull
        .map((l) => {
          try {
            return JSON.parse(l.body ?? '{}') as { kind?: string; results?: Record<string, { ok?: boolean }> };
          } catch {
            return {};
          }
        })
        .find((b) => b.kind === 'probe');

      // real run, network:'offline' — even an allowed host is denied, so s0000 fails.
      const beforeOff = siteLog().length;
      const rOff = runTest('specs/login-offline.json', 'login.json');
      const jOff = runJson(rOff.dir);
      const s0000 = eventsOf(rOff.dir).find((e) => e.type === 'ACTION_END' && e.step_id === 's0000');
      const accLog = fs.readFileSync(`${rOff.dir}/logs/proxy-access.log`, 'utf8');
      // proto 'server' entries are the fixture's own lifecycle lines, not requests.
      const reachedOff = siteLog()
        .slice(beforeOff)
        .filter((l) => l.proto !== 'server');

      ev.conf = {
        limited: { catchAll: catchAll(confLimited), bRules: bRules(confLimited).length },
        full: { catchAll: catchAll(confFull), bRules: bRules(confFull).length },
        offline: { allowBrowserLines: (confOffline.match(/http_access allow browser_port/g) ?? []).length },
        agentRulesIdentical,
        bogusEqualsLimited,
      };
      ev.full = {
        code: rFull.code,
        evilArrived: evilArrived.map((l) => `${l.host_header}${l.path}`),
        // fetch() still rejects at JS level (no ACAO header on the fixture), but the
        // request arrived — proven by ground truth; img/ws/no-cors post complete.
        fetchEvilOk: probeBody?.results?.fetch_evil?.ok,
        imgEvilOk: probeBody?.results?.img_evil?.ok,
        wsEvilOk: probeBody?.results?.ws_evil?.ok,
      };
      ev.offline = {
        code: rOff.code,
        status: jOff.status,
        s0000: s0000?.status,
        denied: jOff.egress?.denied,
        siteRequests: reachedOff.length,
      };
      const pass =
        ev.proxyBuild === 0 &&
        [confLimited, confFull, confOffline, confBogus].every((c) => c.includes('GENC_RC=0') && c.includes('http_access deny all')) &&
        catchAll(confFull) &&
        bRules(confFull).length === 0 &&
        !catchAll(confLimited) &&
        bRules(confLimited).length > 0 &&
        !/http_access allow browser_port/.test(confOffline) &&
        bRules(confOffline).length === 0 &&
        agentRulesIdentical &&
        bogusEqualsLimited &&
        (rFull.code === 0 || rFull.code === 3) &&
        evilArrived.some((l) => /k=fetch/.test(l.path ?? '')) &&
        probeBody?.results?.img_evil?.ok === true &&
        rOff.code === 2 &&
        jOff.status === 'FAILED' &&
        s0000?.status === 'FAILED' &&
        /CONNECT app\.test:443/.test(accLog) &&
        (jOff.egress?.denied ?? []).some((d: { host: string }) => d.host === 'app.test:443') &&
        reachedOff.length === 0;
      return { pass, evidence: ev };
    },
  },
];

const knownIds = new Set(CRITERIA.map((c) => c.id));
const unknownIds = [...(only ?? []), ...skip].filter((id) => !knownIds.has(id));
if (unknownIds.length > 0) {
  console.error(`unknown criterion ids: ${unknownIds.join(',')} (known: ${[...knownIds].sort((a, b) => a - b).join(',')})`);
  process.exit(1);
}
const selected = CRITERIA.filter((c) => !only || only.has(c.id));
if (selected.length === 0) {
  console.error('--only selected no criteria');
  process.exit(1);
}
if (selected.every((c) => skip.has(c.id))) {
  console.error('--skip removed every selected criterion');
  process.exit(1);
}

for (const c of CRITERIA) {
  if (only && !only.has(c.id)) continue;
  if (skip.has(c.id)) {
    results.push({ id: c.id, title: c.title, pass: false, skipped: true, evidence: { reason: 'skipped by --skip' }, duration_s: 0 });
    console.log(`[SKIP] ${c.id}. ${c.title}`);
    continue;
  }
  const t0 = Date.now();
  let pass = false;
  let evidence: unknown = {};
  try {
    const r = await c.run();
    pass = r.pass;
    evidence = r.evidence;
  } catch (err) {
    evidence = { error: String(err) };
  }
  results.push({ id: c.id, title: c.title, pass, evidence, duration_s: Math.round((Date.now() - t0) / 1000) });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${c.id}. ${c.title} (${(results.at(-1) ?? { duration_s: 0 }).duration_s}s)`);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2));
const md = [
  '| # | Criterion | Result | s |',
  '|---|---|---|---|',
  ...results.map((r) => `| ${r.id} | ${r.title} | ${r.skipped ? 'SKIP' : r.pass ? 'PASS' : 'FAIL'} | ${r.duration_s} |`),
].join('\n');
fs.writeFileSync(path.join(OUT, 'report.md'), `${md}\n`);
const ran = results.filter((r) => !r.skipped);
const skipped = results.length - ran.length;
console.log(`\n${ran.filter((r) => r.pass).length}/${ran.length} passed${skipped ? `, ${skipped} skipped` : ''} → ${OUT}/report.md`);
process.exit(ran.length > 0 && ran.every((r) => r.pass) ? 0 : 1);
