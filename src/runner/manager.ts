import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { agentEgressHosts, type RunRequest } from './request.ts';

export type RunState = 'queued' | 'starting' | 'running' | 'exited' | 'cancelled';
export interface RunStatusView {
  state: RunState;
  exit_code?: number;
}

/** One docker invocation (no shell). `args` are passed verbatim to execFile('docker', ...). */
export type DockerExec = (args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; out: string }>;

export interface ManagerOpts {
  root: string; // repo root: cwd for docker compose and base for relative -f files
  dataDir: string;
  maxConcurrent: number; // MAX_CONCURRENT_RUNS
  extraComposeFiles: string[]; // e.g. tests/acceptance/compose.fixtures.yml
  env: NodeJS.ProcessEnv; // usually process.env (UPSTREAM_*, CHROME_WEBGL, SITES_LOG_DIR passthrough)
  exec?: DockerExec; // injectable for tests
  cancelGraceMs?: number; // default 30_000 (§16.1)
}

const defaultExec =
  (root: string): DockerExec =>
  (args, env) =>
    new Promise((resolve, reject) => {
      execFile('docker', args, { cwd: root, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && typeof err.code === 'number') resolve({ code: err.code, out: `${stdout}${stderr}` });
        else if (err) reject(err);
        else resolve({ code: 0, out: `${stdout}${stderr}` });
      });
    });

/** §16.1 run overlay: request dir ro at /run-input, control dir ro at /control. */
export function composeOverlay(dir: string): string {
  return [
    'services:',
    '  orchestrator:',
    '    volumes:',
    `      - "${dir}:/run-input:ro"`,
    `      - "${dir}/control:/control:ro"`,
    '    environment:',
    '      CONTROL_DIR: /control',
    '  proxy:',
    '    volumes:',
    `      - "${dir}/spec.json:/run-input/spec.json:ro"`,
    '',
  ].join('\n');
}

interface Tracked {
  req: RunRequest;
  dir: string;
  overlayFile: string;
  state: RunState;
  exitCode?: number;
  cancelRequested: boolean;
  downed: boolean;
  forceTimer?: NodeJS.Timeout;
  done: Promise<void>;
}

/** §16.1 FIFO queue + per-run docker compose lifecycle (up -d → wait → down -v). */
export class RunManager {
  private readonly queue: Tracked[] = [];
  private readonly runs = new Map<string, Tracked>();
  private readonly exec: DockerExec;
  private readonly graceMs: number;
  private readonly opts: ManagerOpts;
  private active = 0;
  private closing = false;

  constructor(opts: ManagerOpts) {
    this.opts = opts;
    this.exec = opts.exec ?? defaultExec(opts.root);
    this.graceMs = opts.cancelGraceMs ?? 30_000;
  }

  status(runId: string): RunStatusView | null {
    const t = this.runs.get(runId);
    if (!t) return null;
    return t.exitCode === undefined ? { state: t.state } : { state: t.state, exit_code: t.exitCode };
  }

  /** Enqueues a validated request. Throws if the id is known or the runner is closing. */
  enqueue(req: RunRequest, dir: string): RunStatusView {
    if (this.closing) throw new Error('runner is shutting down');
    const existing = this.runs.get(req.runId);
    if (existing) return this.status(req.runId) as RunStatusView;
    const t: Tracked = {
      req,
      dir,
      overlayFile: path.join(dir, 'compose.run.yml'),
      state: 'queued',
      cancelRequested: false,
      downed: false,
      done: Promise.resolve(),
    };
    this.runs.set(req.runId, t);
    this.queue.push(t);
    this.pump();
    return { state: t.state };
  }

  /** §16.1: queued → removed; starting/running → control/cancel + force down after the grace period. */
  cancel(runId: string): 'cancelled' | 'cancelling' | 'unknown' | 'finished' {
    const t = this.runs.get(runId);
    if (!t) return 'unknown';
    if (t.state === 'exited' || t.state === 'cancelled') return 'finished';
    t.cancelRequested = true;
    if (t.state === 'queued') {
      const i = this.queue.indexOf(t);
      if (i >= 0) this.queue.splice(i, 1);
      t.state = 'cancelled';
      return 'cancelled';
    }
    try {
      fs.writeFileSync(path.join(t.dir, 'control', 'cancel'), '');
    } catch {
      /* dir may be gone; the force-down still applies */
    }
    if (!t.forceTimer) {
      t.forceTimer = setTimeout(() => {
        void this.down(t);
      }, this.graceMs);
    }
    return 'cancelling';
  }

  /** Runner shutdown: cancel everything in flight and wait for the lifecycles to settle. */
  async shutdown(): Promise<void> {
    this.closing = true;
    for (const t of [...this.queue]) this.cancel(t.req.runId);
    for (const t of this.runs.values()) if (t.state === 'starting' || t.state === 'running') this.cancel(t.req.runId);
    await Promise.allSettled([...this.runs.values()].map((t) => t.done));
  }

  private pump(): void {
    while (!this.closing && this.active < this.opts.maxConcurrent && this.queue.length > 0) {
      const t = this.queue.shift() as Tracked;
      this.active += 1;
      t.done = this.lifecycle(t);
    }
  }

  private composeArgs(t: Tracked, sub: string[]): string[] {
    const files = ['compose', '-f', 'docker-compose.yml', '-f', t.overlayFile];
    for (const f of this.opts.extraComposeFiles) files.push('-f', f);
    files.push('-p', `run-${t.req.runId}`, ...sub);
    return files;
  }

  private envFor(t: Tracked): NodeJS.ProcessEnv {
    const env = this.opts.env;
    return {
      ...env,
      RUN_ID: t.req.runId,
      TEST_FILE: '/run-input/spec.json',
      AGENT_MODEL: t.req.model,
      AGENT_EGRESS_HOSTS: env.AGENT_EGRESS_HOSTS ?? agentEgressHosts(t.req.provider),
      UPSTREAM_PROXY: env.UPSTREAM_PROXY ?? '',
      UPSTREAM_BYPASS: env.UPSTREAM_BYPASS ?? '',
      CHROME_WEBGL: env.CHROME_WEBGL ?? '0',
    };
  }

  private async down(t: Tracked): Promise<void> {
    if (t.downed) return;
    t.downed = true;
    try {
      await this.exec(this.composeArgs(t, ['down', '-v']), this.envFor(t));
    } catch {
      /* best effort: matches the trap in run-test.sh */
    }
  }

  private async lifecycle(t: Tracked): Promise<void> {
    try {
      t.state = 'starting';
      fs.mkdirSync(path.join(t.dir, 'control'), { recursive: true });
      fs.writeFileSync(t.overlayFile, composeOverlay(t.dir));
      const up = await this.exec(this.composeArgs(t, ['up', '--build', '-d']), this.envFor(t));
      if (up.code === 0) {
        t.state = 'running';
        const ps = await this.exec(this.composeArgs(t, ['ps', '-q', 'orchestrator']), this.envFor(t));
        const cid = ps.out.trim();
        if (cid) {
          const w = await this.exec(['wait', cid], this.envFor(t));
          const code = Number.parseInt(w.out.trim(), 10);
          t.exitCode = Number.isNaN(code) ? undefined : code;
        } else {
          t.exitCode = 1; // orchestrator never started (run-test.sh semantics)
        }
      } else {
        t.exitCode = up.code;
      }
    } catch {
      t.exitCode = t.exitCode ?? 1;
    } finally {
      if (t.forceTimer) clearTimeout(t.forceTimer);
      await this.down(t);
      t.state = t.cancelRequested ? 'cancelled' : 'exited';
      this.active -= 1;
      this.pump();
    }
  }
}
