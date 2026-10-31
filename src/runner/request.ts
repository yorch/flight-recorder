import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import { parseTestSpec } from '../config.ts';

export const RUN_ID_RE = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/;
export const PROVIDERS = ['anthropic', 'openai', 'stub'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** request.json: written by the control plane; only these fields matter to the runner. */
const RequestSchema = z.object({
  run_id: z.string().regex(RUN_ID_RE),
  model: z.string().min(1), // <provider>/<id>; the stub id is a path such as /run-input/stub/script.json
});

export interface RunRequest {
  runId: string;
  model: string;
  provider: Provider;
}

export class RequestError extends Error {}

export function providerOf(model: string): Provider | null {
  const slash = model.indexOf('/');
  if (slash <= 0) return null;
  const p = model.slice(0, slash);
  return (PROVIDERS as readonly string[]).includes(p) ? (p as Provider) : null;
}

/** Model-API egress hosts, same mapping as scripts/run-test.sh. */
export function agentEgressHosts(provider: Provider): string {
  return { anthropic: 'api.anthropic.com', openai: 'api.openai.com', stub: 'stub.invalid' }[provider];
}

/**
 * §16.1: run_id must match RUN_ID_RE and the resolved directory must stay under
 * <dataDir>/requests. Returns null for anything else (caller answers 400).
 */
export function resolveRequestDir(dataDir: string, runId: string): string | null {
  if (!RUN_ID_RE.test(runId)) return null;
  const root = path.resolve(dataDir, 'requests');
  const dir = path.resolve(root, runId);
  if (dir !== path.join(root, runId) || !dir.startsWith(`${root}${path.sep}`)) return null;
  return dir;
}

function readJson(dir: string, file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, file), 'utf8');
  } catch {
    throw new RequestError(`request directory is missing ${file}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError(`${file} is not valid JSON`);
  }
}

/** Validates the request dir contents (§16.1). Throws RequestError → HTTP 400. */
export function loadRunRequest(dir: string, runId: string): RunRequest {
  const parsed = RequestSchema.safeParse(readJson(dir, 'request.json'));
  if (!parsed.success) throw new RequestError(`invalid request.json: ${parsed.error.issues[0]?.message ?? 'bad shape'}`);
  if (parsed.data.run_id !== runId) throw new RequestError('request.json run_id does not match the URL');
  const provider = providerOf(parsed.data.model);
  if (!provider) throw new RequestError(`unknown model provider in '${parsed.data.model}' (expected anthropic|openai|stub)`);
  try {
    parseTestSpec(readJson(dir, 'spec.json'));
  } catch (err) {
    if (err instanceof RequestError) throw err;
    throw new RequestError(`invalid spec.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { runId, model: parsed.data.model, provider };
}
