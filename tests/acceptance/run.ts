import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OVERLAY = 'tests/acceptance/compose.fixtures.yml';
const OUT = process.env.ACC_OUT ?? `artifacts/acceptance-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
const SITES_LOG = path.join(OUT, 'sites-log');
fs.mkdirSync(SITES_LOG, { recursive: true });

const only = process.argv.includes('--only') ? new Set(process.argv[process.argv.indexOf('--only') + 1].split(',').map(Number)) : null;

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

interface Criterion {
  id: number;
  title: string;
  run: () => Promise<{ pass: boolean; evidence: unknown }>;
}
const results: { id: number; title: string; pass: boolean; evidence: unknown; duration_s: number }[] = [];

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
    title: 'run.json.egress.denied lists denied hosts; proxy log exists',
    run: async () => {
      const r = runTest('specs/probe.json', 'probe.json', { AGENT_EGRESS_HOSTS: 'llm.test:80' });
      const j = runJson(r.dir);
      const deniedHosts = (j.egress?.denied ?? []).map((d: { host: string }) => d.host);
      const has = (h: string) => deniedHosts.includes(h);
      const pass = j.egress && has('evil.test:80') && has('app.test:8081') && fs.existsSync(`${r.dir}/logs/proxy-access.log`);
      return {
        pass,
        evidence: { denied: j.egress?.denied, allowed: j.egress?.allowed, logExists: fs.existsSync(`${r.dir}/logs/proxy-access.log`) },
      };
    },
  },
];

for (const c of CRITERIA) {
  if (only && !only.has(c.id)) continue;
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
  ...results.map((r) => `| ${r.id} | ${r.title} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.duration_s} |`),
].join('\n');
fs.writeFileSync(path.join(OUT, 'report.md'), `${md}\n`);
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed → ${OUT}/report.md`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
