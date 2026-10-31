import * as z from 'zod';

const stepId = z.string().regex(/^p\d+$/);
const criterionId = z.string().regex(/^c\d+$/);

export const PlanSchema = z.strictObject({
  title: z.string().min(1).max(80),
  steps: z
    .array(z.strictObject({ id: stepId, intent: z.string().min(1), expected: z.string().min(1) }))
    .min(1)
    .max(30),
  criteria: z
    .array(z.strictObject({ id: criterionId, description: z.string().min(1) }))
    .min(1)
    .max(15),
});
export type Plan = z.infer<typeof PlanSchema>;

/** §15.2: validated plan — schema plus unique step and criterion ids. */
export function parsePlan(json: unknown): Plan {
  const plan = PlanSchema.parse(json);
  const dup = (ids: string[]) => ids.length !== new Set(ids).size;
  if (dup(plan.steps.map((s) => s.id))) throw new Error('Plan has duplicate step ids');
  if (dup(plan.criteria.map((c) => c.id))) throw new Error('Plan has duplicate criterion ids');
  return plan;
}

export const EvaluationSchema = z.strictObject({
  criteria: z.array(
    z.strictObject({
      id: z.string().min(1),
      status: z.enum(['MET', 'NOT_MET', 'UNCLEAR']),
      evidence: z.string(),
      screenshots: z.array(z.string()),
    }),
  ),
  issues: z.array(
    z.strictObject({
      severity: z.enum(['high', 'medium', 'low']),
      title: z.string(),
      description: z.string(),
      plan_step: z.string().nullable(),
      screenshot: z.string().nullable(),
    }),
  ),
  conclusions: z.string(),
});
export type Evaluation = z.infer<typeof EvaluationSchema>;

export const planJsonSchema = z.toJSONSchema(PlanSchema);
export const evaluationJsonSchema = z.toJSONSchema(EvaluationSchema);
