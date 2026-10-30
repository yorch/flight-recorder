import fs from 'node:fs';
import * as z from 'zod';

// The same rules gen-squid-conf enforces (§2.4): an invalid spec fails fast here too.
const ORIGIN_RE = /^(https?):\/\/([^/:]+)(:([0-9]+))?\/?$/;
const HOST_RE = /^(\*\.)?[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;
const HOST_PART_RE = /^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/;

const isValidOrigin = (o: string): boolean => {
  const m = ORIGIN_RE.exec(o);
  if (!m) return false;
  return HOST_PART_RE.test(m[2]);
};

const isValidHostEntry = (h: string): boolean => {
  if (!HOST_RE.test(h)) return false;
  return HOST_PART_RE.test(h.replace(/:[0-9]{1,5}$/, ''));
};

export const SecretBindingSchema = z.object({
  origins: z.array(z.string().min(1)).min(1),
  input_types: z.array(z.string().min(1)).min(1),
});
export type SecretBinding = z.infer<typeof SecretBindingSchema>;

export const ExpectationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('visible'), role: z.string().min(1), name: z.string() }),
  z.object({ kind: z.literal('text'), role: z.string().min(1), name: z.string(), contains: z.string().min(1) }),
  z.object({ kind: z.literal('url'), matches: z.string().min(1) }),
]);
export type Expectation = z.infer<typeof ExpectationSchema>;

export const TestSpecSchema = z.object({
  name: z.string().min(1),
  start_url: z.string().min(1),
  goal: z.string(),
  allowed_origins: z.array(z.string().refine(isValidOrigin, { error: 'invalid allowed_origins entry' })).min(1),
  allowed_hosts: z.array(z.string().refine(isValidHostEntry, { error: 'invalid allowed_hosts entry' })).optional(),
  expect: z.array(ExpectationSchema).optional(),
  secrets: z.record(z.string(), SecretBindingSchema).optional(),
  max_steps: z.number().int().positive().optional(),
  timeout_s: z.number().positive().optional(),
  max_model_tokens: z.number().int().positive().optional(),
});
export type TestSpec = z.infer<typeof TestSpecSchema>;

export function parseTestSpec(json: unknown): TestSpec {
  return TestSpecSchema.parse(json);
}

export function loadTestSpec(file: string): TestSpec {
  return parseTestSpec(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** Exact origin match (scheme://host[:port]); only http/https URLs can match. */
export function isAllowedOrigin(url: string, spec: TestSpec): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return spec.allowed_origins.some((o) => {
    try {
      return new URL(o).origin === parsed.origin;
    } catch {
      return false;
    }
  });
}

export interface Config {
  runId: string;
  testFile: string;
  agentModel: string;
  provider: string;
  model: string;
  cdpUrl: string;
  artifactRoot: string;
  display: string;
  screen: { width: number; height: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`Missing required env ${k}`);
    return v;
  };
  const agentModel = need('AGENT_MODEL');
  const slash = agentModel.indexOf('/');
  if (slash <= 0) throw new Error(`AGENT_MODEL must be <provider>/<model-id>, got ${agentModel}`);
  return {
    runId: need('RUN_ID'),
    testFile: need('TEST_FILE'),
    agentModel,
    provider: agentModel.slice(0, slash),
    model: agentModel.slice(slash + 1),
    cdpUrl: env.CDP_URL ?? 'http://127.0.0.1:9222',
    artifactRoot: env.ARTIFACT_ROOT ?? '/artifacts',
    display: env.DISPLAY ?? ':99',
    screen: {
      width: Number(env.SCREEN_WIDTH ?? 1920),
      height: Number(env.SCREEN_HEIGHT ?? 1080),
    },
  };
}
