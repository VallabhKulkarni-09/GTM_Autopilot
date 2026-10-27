/**
 * llm.ts — QualificationAgent v2: a model judges the fuzzy signals, code keeps the numbers and guard rails.
 *
 *   The model answers yes/no/unknown for industry, country, title and form intent (by meaning, any
 *   language). Company size, points and tier thresholds are computed here from the same ICP policy
 *   as v1 (scoreFromJudgements) — small models are unreliable at arithmetic, and the thresholds are
 *   the customer's settings, not the model's opinion.
 *
 *   1. v1 rules always run first (same ICP policy). Hard gates (free email, below the smallest size)
 *      are final: the model is not asked.
 *   2. The model must be the one that passed the golden set (same digest when the server reports one).
 *   3. Reply is schema-validated; one repair retry; then the rules decide (outcome 'fallback').
 *   4. Model-judged and rules tiers agree on fit/not-fit → the model-judged tier is used.
 *      They disagree → review_required = MODEL_RULES_DISAGREE: the lead goes to a person (routing review),
 *      proposed as the "fit" side so it reaches review instead of being nurtured unseen.
 *
 * Returns exactly one ProposedAction, same shape as v1 plus `decided_by` and `model_context`.
 * The model client is injected; the agent never builds connections or reads the database.
 */
import { scoreIcp } from './rules.js'
import { selectIcpPolicy } from './icp-config.js'
import { buildSystemPrompt, buildUserMessage, leadFacts, parseReply, repairMessage, PROMPT_VERSION, type ParsedReply, type Judgement, type JudgedSignal } from './prompt.js'
import type { IcpConfig } from './icp-config.js'
import type { Company } from '../../domain/db-types.js'
import { ModelError, type ModelClient, type ModelProvider } from '../../models/types.js'
import type { IcpTier, ProposedAction, QualificationInput } from './types.js'

export const QUALIFICATION_V2_VERSION = '2.0.1'   // 2.0.1: max_tokens 1000 for thinking models
// Generous on purpose: "thinking" models (Gemini 2.5, gpt-5, o-series) spend output tokens on reasoning
// before the JSON; with 120 Gemini 2.5 Flash stopped at "Here is the JSON" (finish_reason length).
// The reply itself is ~40 tokens; providers bill used tokens only.
const MAX_TOKENS = 1000

export type QualificationModelContext = {
  model: ModelClient
  modelDigest: string | null       // digest the server reports right now (null if it does not expose one)
  evaluatedDigest: string | null   // digest recorded by the golden-set run that unlocked the agent
}

export type ModelOutcome = 'model' | 'hard_gate' | 'fallback'

export type ModelDecisionContext = {
  outcome: ModelOutcome
  provider: ModelProvider
  model: string
  reportedModel: string | null
  modelDigest: string | null
  promptVersion: string
  temperature: 0
  attempts: number
  latencyMs: number
  rulesTier: IcpTier
  modelTier: IcpTier | null
  modelConfidence: number | null
  fallbackReason: string | null    // ModelError code, MODEL_OUTPUT_INVALID or MODEL_CHANGED_SINCE_EVALUATION
  outputProblem: string | null
  judgements: Record<JudgedSignal, Judgement> | null   // the model's raw answers
}

const fit = (t: IcpTier) => t !== 'not_icp'

/** Same points + thresholds as rules.ts, with the four fuzzy matches taken from the model. */
export function scoreFromJudgements(company: Company | null, config: IcpConfig, signals: Record<JudgedSignal, Judgement>, suspicious: boolean): {
  tier: IcpTier; score: number; reasonCodes: string[]
} {
  const w = config.weights
  let score = 0
  const codes: string[] = []
  const size = company?.employee_count ?? null
  if (size === null) codes.push('ENRICHMENT_MISSING_COMPANY_SIZE')
  else if (size >= config.employee_min && size <= config.employee_max) { score += w.company_size; codes.push('ICP_COMPANY_SIZE_IN_RANGE') }
  else if (size >= config.employee_near_min && size < config.employee_min) { score += w.company_size_near; codes.push('ICP_COMPANY_SIZE_NEAR_RANGE') }
  else if (size > config.employee_max) { score += w.company_size_large; codes.push('ICP_COMPANY_SIZE_LARGE') }
  else codes.push('NOT_ICP_TOO_SMALL')

  const add = (j: Judgement, points: number, yes: string, no: string | null, unknown: string | null) => {
    if (j === 'yes') { score += points; codes.push(yes) }
    else if (j === 'no' && no) codes.push(no)
    else if (j === 'unknown' && unknown) codes.push(unknown)
  }
  add(signals.industry, w.industry, 'ICP_INDUSTRY_MATCH', 'NOT_ICP_INDUSTRY_MISMATCH', 'ENRICHMENT_MISSING_INDUSTRY')
  add(signals.country, w.country, 'ICP_REGION_MATCH', 'NOT_ICP_REGION_EXCLUDED', 'ENRICHMENT_MISSING_REGION')
  add(signals.intent, w.intent, 'ICP_HIGH_INTENT_FORM', null, null)
  add(signals.title, w.title, 'ICP_SENIOR_TITLE', 'NOT_SENIOR_TITLE', null)
  if (suspicious) codes.push('SUSPICIOUS_FORM_CONTENT')

  const clamped = Math.min(100, Math.max(0, score))
  const tier: IcpTier = clamped >= config.tier_thresholds.tier_1 ? 'tier_1' : clamped >= config.tier_thresholds.tier_2 ? 'tier_2' : 'not_icp'
  return { tier, score: clamped, reasonCodes: codes }
}

export class QualificationAgentV2 {
  readonly name = 'qualification-agent'
  readonly version = QUALIFICATION_V2_VERSION
  readonly promptVersion = PROMPT_VERSION

  async execute(input: QualificationInput, ctx: QualificationModelContext): Promise<ProposedAction> {
    const { rule, config } = selectIcpPolicy(input.icpPolicyRules)   // throws ICP_POLICY_MISSING, like v1
    const rules = scoreIcp(input.lead, input.company, config)
    const base = { icp_policy_id: rule.id, icp_policy_version: rule.version, rules_tier: rules.icp_tier }
    const mc: ModelDecisionContext = {
      outcome: 'model', provider: ctx.model.provider, model: ctx.model.model, reportedModel: null,
      modelDigest: ctx.modelDigest, promptVersion: PROMPT_VERSION, temperature: 0, attempts: 0, latencyMs: 0,
      rulesTier: rules.icp_tier, modelTier: null, modelConfidence: null, fallbackReason: null, outputProblem: null, judgements: null,
    }
    const rulesResult = (outcome: Exclude<ModelOutcome, 'model'>, extraCodes: string[]): ProposedAction => ({
      type: 'qualify_lead',
      parameters: { ...rules, ...base, reason_codes: [...rules.reason_codes, ...extraCodes], decided_by: 'rules', model_context: { ...mc, outcome } },
      decisionRiskScore: 0.0,
      rawConfidence: 1.0,
    })

    if (rules.reason_codes.some(c => c.startsWith('DISQUALIFIED_'))) return rulesResult('hard_gate', [])

    if (ctx.evaluatedDigest !== ctx.modelDigest) {
      mc.fallbackReason = 'MODEL_CHANGED_SINCE_EVALUATION'
      return rulesResult('fallback', ['MODEL_FALLBACK_RULES'])
    }

    const system = buildSystemPrompt(config)
    const user = buildUserMessage(leadFacts(input.lead, input.company))
    let reply: ParsedReply | null = null
    try {
      let prompt = user
      for (let attempt = 1; attempt <= 2 && !reply; attempt++) {
        mc.attempts = attempt
        const res = await ctx.model.chat({ system, user: prompt, maxTokens: MAX_TOKENS, json: true })
        mc.latencyMs += res.latencyMs
        mc.reportedModel = res.model
        const parsed = parseReply(res.text)
        if (parsed.ok) reply = parsed.value
        else {
          mc.outputProblem = parsed.problem
          prompt = `${user}\n\n${repairMessage(parsed.problem)}`
        }
      }
    } catch (e) {
      if (!(e instanceof ModelError)) throw e
      mc.fallbackReason = e.code
      return rulesResult('fallback', ['MODEL_FALLBACK_RULES'])
    }
    if (!reply) {
      mc.fallbackReason = 'MODEL_OUTPUT_INVALID'
      return rulesResult('fallback', ['MODEL_FALLBACK_RULES'])
    }

    mc.outputProblem = null
    const judged = scoreFromJudgements(input.company, config, reply.signals, reply.suspicious)
    mc.modelTier = judged.tier
    mc.modelConfidence = reply.confidence
    mc.judgements = reply.signals
    const disagree = fit(judged.tier) !== fit(rules.icp_tier)
    const tier: IcpTier = disagree ? (fit(judged.tier) ? judged.tier : rules.icp_tier) : judged.tier
    return {
      type: 'qualify_lead',
      parameters: {
        is_icp_fit: fit(tier),
        icp_score: judged.score,
        icp_tier: tier,
        reason_codes: ['MODEL_DECISION', ...judged.reasonCodes, ...(disagree ? ['MODEL_RULES_DISAGREE'] : [])],
        ...base,
        rules_score: rules.icp_score,
        decided_by: 'model',
        model_tier: judged.tier,
        ...(disagree ? { review_required: 'MODEL_RULES_DISAGREE' } : {}),
        model_context: mc,
      },
      decisionRiskScore: disagree ? 0.9 : Math.round((1 - reply.confidence) * 100) / 100,
      rawConfidence: reply.confidence,
    }
  }
}

export const qualificationAgentV2 = new QualificationAgentV2()
