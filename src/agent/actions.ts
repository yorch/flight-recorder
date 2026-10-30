import * as z from 'zod';

const label = z.string().min(1).max(120);
const ref = z.string().regex(/^(f\d+)?e\d+$/);
const point = { x: z.number(), y: z.number() };
const role = { role: z.string().min(1), name: z.string() };

export const ALLOWED_KEYS = [
  'Enter',
  'Tab',
  'Shift+Tab',
  'Escape',
  'Backspace',
  'Delete',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
] as const;

export const AgentAction = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('navigate'), label, url: z.httpUrl() }),
  z.strictObject({ kind: z.literal('click'), label, ref }),
  z.strictObject({ kind: z.literal('click_at'), label, ...point }),
  z.strictObject({ kind: z.literal('type'), label, ref, text: z.string().max(2000), mode: z.enum(['replace', 'append']) }),
  z.strictObject({ kind: z.literal('press'), label, key: z.enum(ALLOWED_KEYS) }),
  z.strictObject({ kind: z.literal('scroll'), label, ...point, dy: z.number().min(-5000).max(5000) }),
  z.strictObject({ kind: z.literal('dialog'), label, accept: z.boolean(), prompt_text: z.string().nullable() }),
  z.strictObject({ kind: z.literal('assert_visible'), label, ...role }),
  z.strictObject({ kind: z.literal('assert_text'), label, ...role, contains: z.string().min(1) }),
  z.strictObject({ kind: z.literal('assert_visual'), label, verdict: z.enum(['PASSED', 'FAILED']), reasoning: z.string() }),
  z.strictObject({ kind: z.literal('done'), status: z.enum(['PASSED', 'FAILED']), summary: z.string() }),
]);
export type AgentAction = z.infer<typeof AgentAction>;

export const AgentTurn = z.strictObject({ action: AgentAction });
export type AgentTurn = z.infer<typeof AgentTurn>;
export const agentTurnJsonSchema = z.toJSONSchema(AgentTurn);

const FORBIDDEN_KEYS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  '$schema',
]);

/** Rewrites a zod JSON schema into a provider-strict wire schema (§6.2 decision 4). */
export function toWireSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toWireSchema);
  if (node === null || typeof node !== 'object') return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    if (k === 'oneOf') {
      out.anyOf = toWireSchema(v);
      continue;
    }
    out[k] = toWireSchema(v);
  }
  const props = out.properties as Record<string, unknown> | undefined;
  if (props) {
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

const ENUM_SETS: Record<string, readonly string[]> = {
  kind: ['navigate', 'click', 'click_at', 'type', 'press', 'scroll', 'dialog', 'assert_visible', 'assert_text', 'assert_visual', 'done'],
  verdict: ['PASSED', 'FAILED'],
  status: ['PASSED', 'FAILED'],
  mode: ['replace', 'append'],
  key: ALLOWED_KEYS,
};

/**
 * Providers do not guarantee enum casing. Maps string values in the model's reply
 * onto the known literal sets, case-insensitively (decision 5).
 */
export function normalizeEnums(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.map(normalizeEnums);
  if (raw === null || typeof raw !== 'object') return raw;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const known = ENUM_SETS[k];
    if (known && typeof v === 'string') {
      const canon = known.find((lit) => lit.toLowerCase() === v.toLowerCase());
      out[k] = canon ?? v;
    } else {
      out[k] = normalizeEnums(v);
    }
  }
  return out;
}
