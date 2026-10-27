/**
 * ai-model-evaluation.repository.ts — golden-set runs + the qualification agent switch (migration 035).
 * Queries only; every query scoped by organization_id first.
 */
import { getDb } from '../db/client.js'
import type { EvaluationCaseResult, EvaluationSummary, RoutingCaseResult } from '../evaluation/evaluate-model.js'

export type EvaluationStatus = 'running' | 'completed' | 'failed'

export type EvaluationRow = {
  id: string
  agent: 'qualification'
  provider: string
  model: string
  model_digest: string | null
  prompt_version: string
  agent_version: string
  dataset_version: string
  status: EvaluationStatus
  summary: (EvaluationSummary & { done?: number }) | null
  results: EvaluationCaseResult[] | null
  routing_prompt_version: string | null
  routing_agent_version: string | null
  routing_results: RoutingCaseResult[] | null
  error: string | null
  started_at: string
  completed_at: string | null
}

export type NewEvaluation = Pick<EvaluationRow, 'provider' | 'model' | 'prompt_version' | 'agent_version' | 'dataset_version' | 'routing_prompt_version' | 'routing_agent_version'> & { requested_by: string }

/** A run stuck in 'running' this long is treated as dead (worker restarted mid-run). */
export const STALE_RUN_MINUTES = 30

const COLS = 'id, agent, provider, model, model_digest, prompt_version, agent_version, dataset_version, routing_prompt_version, routing_agent_version, routing_results, status, summary, results, error, started_at, completed_at'

/** Inserts a running row. Returns null when another run is already in progress for this workspace. */
export async function createEvaluation(organizationId: string, e: NewEvaluation): Promise<EvaluationRow | null> {
  const db = getDb()
  const staleBefore = new Date(Date.now() - STALE_RUN_MINUTES * 60_000).toISOString()
  const { error: staleErr } = await db.from('ai_model_evaluation')
    .update({ status: 'failed', error: 'RUN_TIMED_OUT', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('organization_id', organizationId).eq('status', 'running').lt('started_at', staleBefore)
  if (staleErr) throw new Error(`createEvaluation (stale cleanup) failed: ${staleErr.message}`)

  const { data, error } = await db.from('ai_model_evaluation')
    .insert({ organization_id: organizationId, agent: 'qualification', status: 'running', ...e })
    .select(COLS).single()
  if (error?.code === '23505') return null
  if (error) throw new Error(`createEvaluation failed: ${error.message}`)
  return data as EvaluationRow
}

export async function getEvaluation(organizationId: string, id: string): Promise<EvaluationRow | null> {
  const { data, error } = await getDb().from('ai_model_evaluation').select(COLS)
    .eq('organization_id', organizationId).eq('id', id).maybeSingle()
  if (error) throw new Error(`getEvaluation failed: ${error.message}`)
  return (data as EvaluationRow) ?? null
}

export async function getLatestEvaluation(organizationId: string): Promise<EvaluationRow | null> {
  const { data, error } = await getDb().from('ai_model_evaluation').select(COLS)
    .eq('organization_id', organizationId).order('started_at', { ascending: false }).limit(1).maybeSingle()
  if (error) throw new Error(`getLatestEvaluation failed: ${error.message}`)
  return (data as EvaluationRow) ?? null
}

export async function updateEvaluationProgress(organizationId: string, id: string, done: number, total: number): Promise<void> {
  const { error } = await getDb().from('ai_model_evaluation')
    .update({ summary: { done, total }, updated_at: new Date().toISOString() })
    .eq('organization_id', organizationId).eq('id', id).eq('status', 'running')
  if (error) throw new Error(`updateEvaluationProgress failed: ${error.message}`)
}

export async function completeEvaluation(organizationId: string, id: string, r: {
  modelDigest: string | null; summary: EvaluationSummary; results: EvaluationCaseResult[]; routingResults: RoutingCaseResult[]
}): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await getDb().from('ai_model_evaluation')
    .update({ status: 'completed', model_digest: r.modelDigest, summary: r.summary, results: r.results, routing_results: r.routingResults, completed_at: now, updated_at: now })
    .eq('organization_id', organizationId).eq('id', id).eq('status', 'running')
  if (error) throw new Error(`completeEvaluation failed: ${error.message}`)
}

export async function failEvaluation(organizationId: string, id: string, reason: string): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await getDb().from('ai_model_evaluation')
    .update({ status: 'failed', error: reason.slice(0, 500), completed_at: now, updated_at: now })
    .eq('organization_id', organizationId).eq('id', id).eq('status', 'running')
  if (error) throw new Error(`failEvaluation failed: ${error.message}`)
}

export async function setRoutingAgent(organizationId: string, enabled: boolean, evaluationId: string | null): Promise<void> {
  const { error } = await getDb().from('ai_model_config')
    .update({ routing_agent_enabled: enabled, routing_evaluation_id: evaluationId, updated_at: new Date().toISOString() })
    .eq('organization_id', organizationId)
  if (error) throw new Error(`setRoutingAgent failed: ${error.message}`)
}

export async function setQualificationAgent(organizationId: string, enabled: boolean, evaluationId: string | null): Promise<void> {
  const { error } = await getDb().from('ai_model_config')
    .update({ qualification_agent_enabled: enabled, qualification_evaluation_id: evaluationId, updated_at: new Date().toISOString() })
    .eq('organization_id', organizationId)
  if (error) throw new Error(`setQualificationAgent failed: ${error.message}`)
}
