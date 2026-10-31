import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RunManager } from './manager.ts';
import { loadRunRequest, RequestError, RUN_ID_RE, resolveRequestDir } from './request.ts';
import { tokenMatches } from './token.ts';

export interface RunnerHttpDeps {
  token: string;
  dataDir: string;
  manager: RunManager;
}

const json = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage, cap = 1024 * 1024): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > cap) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

/** §16.1 runner API: bearer auth on every endpoint. */
export function createRunnerHandler(deps: RunnerHttpDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const auth = req.headers.authorization ?? '';
    const provided = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    if (!tokenMatches(provided, deps.token)) return json(res, 401, { error: 'unauthorized' });

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://runner');
    } catch {
      return json(res, 400, { error: 'bad request' });
    }
    if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { ok: true });

    if (url.pathname === '/runs' && req.method === 'POST') {
      let runId: string;
      try {
        const body = JSON.parse((await readBody(req)).toString('utf8')) as { run_id?: unknown };
        if (typeof body?.run_id !== 'string') return json(res, 400, { error: 'run_id required' });
        runId = body.run_id;
      } catch {
        return json(res, 400, { error: 'invalid JSON body' });
      }
      const dir = resolveRequestDir(deps.dataDir, runId);
      if (!dir) return json(res, 400, { error: 'invalid run_id' });
      try {
        const request = loadRunRequest(dir, runId); // 400s: missing dir/files, bad spec, unknown provider
        const state = deps.manager.enqueue(request, dir);
        return json(res, 202, { run_id: runId, ...state });
      } catch (err) {
        if (err instanceof RequestError) return json(res, 400, { error: err.message });
        return json(res, 503, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    const m = /^\/runs\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (!m) return json(res, 404, { error: 'not found' });
    let runId: string;
    try {
      runId = decodeURIComponent(m[1]);
    } catch {
      return json(res, 400, { error: 'invalid run_id' });
    }
    if (!RUN_ID_RE.test(runId)) return json(res, 400, { error: 'invalid run_id' });

    if (m[2] === '/cancel') {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      const r = deps.manager.cancel(runId);
      if (r === 'unknown') return json(res, 404, { error: 'unknown run' });
      return json(res, 200, { state: deps.manager.status(runId)?.state ?? 'cancelled' });
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    const st = deps.manager.status(runId);
    if (!st) return json(res, 404, { error: 'unknown run' });
    return json(res, 200, st);
  };
}
