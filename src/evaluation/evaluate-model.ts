/**
 * evaluate-model.ts — runs QualificationAgent v2 with a given model over the golden set.
 * This is the gate: the agent can only be switched on for a (provider, model, digest, prompt, agent)
 * that has a completed run. Agreement uses the model's own tier (model_tier) when it answered, so
 * a disagreement that would go to review still counts as a miss for the model.
 */
import { QualificationAgentV2, QUALIFICATION_V2_VERSION, type ModelDecisionContext } from '../agents/qualification/llm.js'
import { PROMPT_VERSION } from '../agents/qualification/prompt.js'
import type { IcpTier } from '../agents/qualification/types.js'
import type { ModelClient } from '../models/types.js'
import { GOLDEN_CASES, GOLDEN_DATASET_VERSION } from './datasets/golden.js'
import { buildQualificationInput, buildRoutingInput } from './build.js'
import { RoutingAgentV2, ROUTING_PROMPT_VERSION, ROUTING_V2_VERSION, type RoutingDecisionContext } from '../agents/routing/llm.js'
import { qualificationAgent } from '../agents/qualification/index.js'
import { routingOutcomeOf, type RoutingOutcomeSummary } from './replay.js'
import type { ExpectedRouting } from './types.js'
import { runGolden, v1Decider } from './replay.js'
import type { GoldenCase } from './types.js'

export type EvaluationCaseResult = {
  caseId: string
  description: string
  tags: string[]
  expected: IcpTier
  acceptable: IcpTier[]
  actual: IcpTier | null
  agrees: boolean
  outcome: ModelDecisionContext['outcome'] | 'error'
  review: boolean
  fallbackReason: string | null
  latencyMs: number
}

export type EvaluationSummary = {
  agreed: number
  total: number
  injection: { agreed: number; total: number }
  reviews: number
  fallbacks: number
  hardGates: number
  errors: number
  avgModelLatencyMs: number | null
  baseline: { agreed: number; total: number }   // v1 rules on the same cases
  routing?: RoutingSummary
}

/** Routing cases only. "asked" = cases where the country was not already an ISO code. */
export type RoutingSummary = {
  agreed: number
  total: number
  asked: number
  fallbacks: number
  baseline: { agreed: number; total: number }
}

export type RoutingCaseResult = {
  caseId: string
  description: string
  expected: ExpectedRouting
  actual: RoutingOutcomeSummary | null
  agrees: boolean
  outcome: RoutingDecisionContext['outcome'] | 'error'
  countryRaw: string | null
  countryCode: string | null
  fallbackReason: string | null
}

function sameRouting(a: RoutingOutcomeSummary, e: ExpectedRouting): boolean {
  if (a.action === 'assign_owner' && e.action === 'assign_owner') return a.ownerId === e.ownerId && a.queue === e.queue
  if (a.action === 'request_human_review' && e.action === 'request_human_review') return a.reason === e.reason
  return false
}

export type ModelEvaluation = {
  datasetVersion: string
  promptVersion: string
  agentVersion: string
  routingPromptVersion: string
  routingAgentVersion: string
  modelDigest: string | null
  summary: EvaluationSummary
  results: EvaluationCaseResult[]
  routingResults: RoutingCaseResult[]
}

export async function evaluateQualificationModel(
  model: ModelClient,
  opts: { cases?: GoldenCase[]; onProgress?: (done: number, total: number) => void | Promise<void> } = {},
): Promise<ModelEvaluation> {
  const cases = opts.cases ?? GOLDEN_CASES
  const modelDigest = await model.modelDigest()
  const agent = new QualificationAgentV2()
  const results: EvaluationCaseResult[] = []

  for (const c of cases) {
    const acceptable = c.expected.acceptableTiers ?? [c.expected.tier]
    const row: EvaluationCaseResult = {
      caseId: c.id, description: c.description, tags: c.tags, expected: c.expected.tier, acceptable,
      actual: null, agrees: false, outcome: 'error', review: false, fallbackReason: null, latencyMs: 0,
    }
    try {
      const p = (await agent.execute(buildQualificationInput(c), { model, modelDigest, evaluatedDigest: modelDigest })).parameters as {
        icp_tier: IcpTier; model_tier?: IcpTier; review_required?: string; model_context: ModelDecisionContext
      }
      row.actual = p.model_tier ?? p.icp_tier
      row.agrees = acceptable.includes(row.actual)
      row.outcome = p.model_context.outcome
      row.review = Boolean(p.review_required)
      row.fallbackReason = p.model_context.fallbackReason
      row.latencyMs = p.model_context.latencyMs
    } catch (e) {
      row.fallbackReason = e instanceof Error ? e.message.slice(0, 200) : 'UNKNOWN_ERROR'
    }
    results.push(row)
    await opts.onProgress?.(results.length, cases.length + cases.filter(x => x.routing).length)
  }

  // Routing: the same model normalises the country; v1 qualification feeds routing (routing does not read it).
  const router = new RoutingAgentV2()
  const routingResults: RoutingCaseResult[] = []
  for (const c of cases.filter(x => x.routing && x.expected.routing)) {
    const expected = c.expected.routing as ExpectedRouting
    const row: RoutingCaseResult = {
      caseId: c.id, description: c.description, expected, actual: null, agrees: false, outcome: 'error',
      countryRaw: c.company?.country ?? null, countryCode: null, fallbackReason: null,
    }
    try {
      const q = qualificationAgent.run(buildQualificationInput(c))
      const out = await router.execute(buildRoutingInput(c, q), { model, modelDigest, evaluatedDigest: modelDigest })
      const mc = (out.parameters as { model_context: RoutingDecisionContext }).model_context
      row.actual = routingOutcomeOf(out)
      row.agrees = sameRouting(row.actual, expected)
      row.outcome = mc.outcome
      row.countryCode = mc.countryCode
      row.fallbackReason = mc.fallbackReason
    } catch (e) {
      row.fallbackReason = e instanceof Error ? e.message.slice(0, 200) : 'UNKNOWN_ERROR'
    }
    routingResults.push(row)
    await opts.onProgress?.(results.length + routingResults.length, cases.length + cases.filter(x => x.routing).length)
  }

  const goldenV1 = (await runGolden(v1Decider, cases)).summary
  const baseline = goldenV1.qualification
  const injection = results.filter(r => r.tags.includes('injection'))
  const answered = results.filter(r => r.outcome === 'model')
  return {
    datasetVersion: GOLDEN_DATASET_VERSION,
    promptVersion: PROMPT_VERSION,
    agentVersion: QUALIFICATION_V2_VERSION,
    routingPromptVersion: ROUTING_PROMPT_VERSION,
    routingAgentVersion: ROUTING_V2_VERSION,
    modelDigest,
    summary: {
      agreed: results.filter(r => r.agrees).length,
      total: results.length,
      injection: { agreed: injection.filter(r => r.agrees).length, total: injection.length },
      reviews: results.filter(r => r.review).length,
      fallbacks: results.filter(r => r.outcome === 'fallback').length,
      hardGates: results.filter(r => r.outcome === 'hard_gate').length,
      errors: results.filter(r => r.outcome === 'error').length,
      avgModelLatencyMs: answered.length ? Math.round(answered.reduce((s, r) => s + r.latencyMs, 0) / answered.length) : null,
      baseline: { agreed: baseline.agreed, total: baseline.total },
      routing: {
        agreed: routingResults.filter(r => r.agrees).length,
        total: routingResults.length,
        asked: routingResults.filter(r => r.outcome === 'model' || r.outcome === 'fallback').length,
        fallbacks: routingResults.filter(r => r.outcome === 'fallback').length,
        baseline: { agreed: goldenV1.routing?.agreed ?? 0, total: goldenV1.routing?.total ?? 0 },
      },
    },
    results,
    routingResults,
  }
}
