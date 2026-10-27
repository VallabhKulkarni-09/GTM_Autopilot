/**
 * policy-engine.ts
 * Evaluates PolicyRule conditions against a Lead + Company.
 * Supports: in, not_in, eq, neq, gte, lte, contains, and, or
 */

import { getDb } from '../db/client.js'
import type { Lead, Company } from '../domain/db-types.js'
import type { PolicyEvaluationResult, Condition } from './types.js'

// ─── Field resolver ───────────────────────────────────────────────────────────

function resolveField(field: string, lead: Lead, company: Company | null): unknown {
  // Check company fields first
  if (company && field in company) return (company as any)[field]
  // Then lead fields
  if (field in lead) return (lead as any)[field]
  return undefined
}

// ─── Condition evaluator ──────────────────────────────────────────────────────

function evaluateCondition(cond: Condition, lead: Lead, company: Company | null): boolean {
  switch (cond.operator) {
    case 'and':
      return (cond.conditions ?? []).every(c => evaluateCondition(c, lead, company))

    case 'or':
      return (cond.conditions ?? []).some(c => evaluateCondition(c, lead, company))

    case 'in': {
      const v = resolveField(cond.field!, lead, company)
      if (v === null || v === undefined) return false
      return (cond.values ?? []).map(String).includes(String(v).toUpperCase())
    }

    case 'not_in': {
      const v = resolveField(cond.field!, lead, company)
      if (v === null || v === undefined) return true  // absent = not in list = pass
      return !(cond.values ?? []).map(String).includes(String(v).toUpperCase())
    }

    case 'eq': {
      const v = resolveField(cond.field!, lead, company)
      return String(v ?? '').toLowerCase() === String(cond.value ?? '').toLowerCase()
    }

    case 'neq': {
      const v = resolveField(cond.field!, lead, company)
      return String(v ?? '').toLowerCase() !== String(cond.value ?? '').toLowerCase()
    }

    case 'gte': {
      const v = Number(resolveField(cond.field!, lead, company) ?? NaN)
      return !isNaN(v) && v >= Number(cond.value)
    }

    case 'lte': {
      const v = Number(resolveField(cond.field!, lead, company) ?? NaN)
      return !isNaN(v) && v <= Number(cond.value)
    }

    case 'contains': {
      const v = String(resolveField(cond.field!, lead, company) ?? '').toLowerCase()
      return v.includes(String(cond.value ?? '').toLowerCase())
    }

    default:
      return false
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

import type { PolicyRule } from '../domain/db-types.js'

export async function evaluatePolicy(
  rule: PolicyRule,
  lead: Lead,
  company: Company | null
): Promise<PolicyEvaluationResult> {
  const condition = (rule as any).condition as Condition | null
  const passed = condition ? evaluateCondition(condition, lead, company) : true

  return {
    passed,
    ruleName: rule.name,
    ruleId: rule.id,
    reason: passed
      ? `Rule "${rule.name}" passed`
      : `Rule "${rule.name}" rejected — condition not met`,
    reasonCode: passed
      ? `POLICY_${rule.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PASSED`
      : `POLICY_${rule.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_REJECTED`,
  }
}

export async function getApplicablePolicies(
  organizationId: string,
  ruleType: string
): Promise<PolicyRule[]> {
  const { data, error } = await getDb()
    .from('policy_rules')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('rule_type', ruleType)
    .eq('is_active', true)
    .order('priority', { ascending: false })

  if (error) throw new Error(`[policy-engine] Failed to load policies: ${error.message}`)
  return (data ?? []) as PolicyRule[]
}
