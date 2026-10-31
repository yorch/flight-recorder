import * as z from 'zod';

const label = z.string().min(1).max(120);
const ref = z.string().regex(/^(f\d+)?e\d+$/);
const point = { x: z.number(), y: z.number() };
const role = { role: z.string().min(1), name: z.string() };
/** Plan step id pN; nullable so runs without a plan can pass null (the loop enforces non-null when a plan exists). */
const plan_step = z
  .string()
  .regex(/^p\d+$/)
  .nullable();
const criterion = z
  .string()
  .regex(/^c\d+$/)
  .nullable();

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
  z.strictObject({ kind: z.literal('navigate'), label, plan_step, url: z.httpUrl() }),
  z.strictObject({ kind: z.literal('click'), label, plan_step, ref }),
  z.strictObject({ kind: z.literal('click_at'), label, plan_step, ...point }),
  z.strictObject({ kind: z.literal('type'), label, plan_step, ref, text: z.string().max(2000), mode: z.enum(['replace', 'append']) }),
  z.strictObject({ kind: z.literal('press'), label, plan_step, key: z.enum(ALLOWED_KEYS) }),
  z.strictObject({ kind: z.literal('scroll'), label, plan_step, ...point, dy: z.number().min(-5000).max(5000) }),
  z.strictObject({ kind: z.literal('dialog'), label, plan_step, accept: z.boolean(), prompt_text: z.string().nullable() }),
  z.strictObject({ kind: z.literal('assert_visible'), label, plan_step, criterion, ...role }),
  z.strictObject({ kind: z.literal('assert_text'), label, plan_step, criterion, ...role, contains: z.string().min(1) }),
  z.strictObject({ kind: z.literal('assert_url'), label, plan_step, criterion, matches: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('assert_visual'),
    label,
    plan_step,
    criterion,
    verdict: z.enum(['PASSED', 'FAILED']),
    reasoning: z.string(),
  }),
  z.strictObject({ kind: z.literal('step_done'), label, plan_step, status: z.enum(['PASSED', 'FAILED']), notes: z.string() }),
  z.strictObject({ kind: z.literal('upload'), label, plan_step, ref, files: z.array(z.string().min(1)).min(1).max(20) }),
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
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
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
  kind: [
    'navigate',
    'click',
    'click_at',
    'type',
    'press',
    'scroll',
    'dialog',
    'assert_visible',
    'assert_text',
    'assert_url',
    'assert_visual',
    'step_done',
    'upload',
    'done',
  ],
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
/**
 * Wire schema for the agent turn (§15.3). Two Anthropic-specific adaptations on top of
 * toWireSchema, which alone produces a schema the API rejects:
 * - `label` and `plan_step` move from every action variant up to the turn object, so they
 *   appear once instead of 13 times (the compiled grammar for 14 fully-inlined anyOf
 *   branches exceeds the provider's size limit). The loop folds them back into the action
 *   before zod validation.
 * - `plan_step`/`criterion` become enums over the plan's real ids instead of nullable
 *   strings, which stays under the 16 union-parameter limit and stops the model inventing
 *   ids. Without a plan both must be null. Server-side validation still uses AgentTurn.
 */
export function agentWireSchema(plan?: { steps: { id: string }[]; criteria: { id: string }[] }): object {
  const wire = toWireSchema(agentTurnJsonSchema) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const action = wire.properties?.action as { anyOf?: { properties?: Record<string, unknown>; required?: string[] }[] } | undefined;
  const stepEnum: unknown[] = plan ? plan.steps.map((s) => s.id) : [null];
  const criterionEnum: unknown[] = plan ? [...plan.criteria.map((c) => c.id), null] : [null];
  for (const branch of action?.anyOf ?? []) {
    const props = branch.properties ?? {};
    delete props.label;
    delete props.plan_step;
    if ('criterion' in props) props.criterion = { enum: criterionEnum };
    branch.required = Object.keys(props);
  }
  if (wire.properties) {
    wire.properties.label = { type: 'string' };
    wire.properties.plan_step = { enum: stepEnum };
    wire.required = Object.keys(wire.properties);
  }
  return wire;
}
