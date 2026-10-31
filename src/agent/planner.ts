import type { TestSpec } from '../config.ts';
import { toWireSchema } from './actions.ts';
import type { ModelClient } from './contract.ts';
import { type Evaluation, EvaluationSchema, evaluationJsonSchema, type Plan, parsePlan, planJsonSchema } from './plan.ts';
import { EVALUATOR_SYSTEM_PROMPT, PLANNER_SYSTEM_PROMPT } from './plan-prompts.ts';

/** §15.2 planner user turn: instructions + inputs only — no page content reaches the planner. */
export function plannerUserText(spec: TestSpec): string {
  const secrets = Object.keys(spec.secrets ?? {});
  return [
    `Instructions: ${spec.goal}`,
    `Start URL: ${spec.start_url}`,
    `Available files: ${spec.assets?.length ? spec.assets.join(', ') : 'none'}`,
    `Available secrets: ${secrets.length ? secrets.map((n) => `{{secret:${n}}}`).join(', ') : 'none'}`,
  ].join('\n');
}

export async function runPlanner(model: ModelClient, spec: TestSpec): Promise<Plan | null> {
  const reply = await model.structured({
    system: PLANNER_SYSTEM_PROMPT,
    parts: [{ type: 'text', text: plannerUserText(spec) }],
    schema: toWireSchema(planJsonSchema) as object,
    name: 'agent_plan',
  });
  if (reply.raw === null) return null; // provider signalled "no plan" (legacy scripts)
  return parsePlan(reply.raw);
}

export interface EvaluatorInputs {
  spec: TestSpec;
  plan: Plan;
  stepLog: string; // compact text: per action — label, plan step, result, error
  assertions: string; // per assertion — outcome + criterion
  summary: string;
  screenshots: { name: string; png: Buffer }[]; // <=8, already resized
}

/** §15.4 evaluator user turn: labelled sections; screenshots are separate image parts. */
export function evaluatorUserText(input: EvaluatorInputs): string {
  const { spec, plan } = input;
  return [
    `Instructions: ${spec.goal}`,
    `Start URL: ${spec.start_url}`,
    `Plan: ${plan.title}`,
    'Plan steps:',
    ...plan.steps.map((s) => `- ${s.id} ${s.intent} (expected: ${s.expected})`),
    'Criteria:',
    ...plan.criteria.map((c) => `- ${c.id} ${c.description}`),
    'Step log:',
    input.stepLog || '(no actions recorded)',
    'Assertions:',
    input.assertions || '(none)',
    `Agent summary: ${input.summary}`,
    `Screenshots: ${input.screenshots.length ? input.screenshots.map((s) => s.name).join(', ') : 'none'}`,
  ].join('\n');
}

export async function runEvaluator(model: ModelClient, input: EvaluatorInputs): Promise<Evaluation> {
  const reply = await model.structured({
    system: EVALUATOR_SYSTEM_PROMPT,
    parts: [
      { type: 'text', text: evaluatorUserText(input) },
      ...input.screenshots.slice(0, 8).map((s) => ({ type: 'image' as const, png: s.png })),
    ],
    schema: toWireSchema(evaluationJsonSchema) as object,
    name: 'agent_eval',
  });
  return EvaluationSchema.parse(reply.raw);
}
