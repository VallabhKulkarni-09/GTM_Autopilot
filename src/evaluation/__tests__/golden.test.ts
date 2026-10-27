/**
 * Golden dataset: integrity checks + v1 rule baseline.
 * v1 must agree with every case except those marked v1Disagrees — and must really disagree there,
 * so the labels stay honest when rules or the dataset change.
 */
import { describe, it, expect } from 'vitest'
import { GOLDEN_CASES } from '../datasets/golden.js'
import { buildQualificationInput, buildRoutingInput } from '../build.js'
import { qualificationAgent } from '../../agents/qualification/index.js'
import { routingAgent } from '../../agents/routing/index.js'
import { parseIcpConfig } from '../../agents/qualification/icp-config.js'
import type { GoldenCase } from '../types.js'

const acceptable = (c: GoldenCase) => c.expected.acceptableTiers ?? [c.expected.tier]

describe('golden dataset integrity', () => {
  it('has 30–50 cases with unique kebab-case ids', () => {
    expect(GOLDEN_CASES.length).toBeGreaterThanOrEqual(30)
    expect(GOLDEN_CASES.length).toBeLessThanOrEqual(50)
    const ids = GOLDEN_CASES.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it('covers every tier, live runs, injection and v1-disagreement cases', () => {
    for (const t of ['tier_1', 'tier_2', 'not_icp']) expect(GOLDEN_CASES.some(c => c.expected.tier === t)).toBe(true)
    expect(GOLDEN_CASES.filter(c => c.origin === 'live').length).toBeGreaterThanOrEqual(2)
    expect(GOLDEN_CASES.filter(c => c.tags.includes('injection')).length).toBeGreaterThanOrEqual(3)
    expect(GOLDEN_CASES.filter(c => c.v1Disagrees?.length).length).toBeGreaterThanOrEqual(3)
    expect(GOLDEN_CASES.filter(c => c.expected.routing).length).toBeGreaterThanOrEqual(10)
  })

  it.each(GOLDEN_CASES)('$id is well-formed', c => {
    expect(acceptable(c)).toContain(c.expected.tier)
    expect(!!c.routing).toBe(!!c.expected.routing)
    if (c.expected.routing) expect(c.expected.tier).not.toBe('not_icp')
    expect(() => parseIcpConfig(buildQualificationInput(c).icpPolicyRules[0].conditions)).not.toThrow()
    expect(JSON.parse(JSON.stringify(c))).toEqual(c) // plain data, replayable
  })
})

describe('v1 rules vs golden labels', () => {
  it.each(GOLDEN_CASES)('$id', c => {
    const q = qualificationAgent.run(buildQualificationInput(c))
    const p = q.parameters as { icp_tier: string; reason_codes: string[] }
    const qualAgrees = acceptable(c).includes(p.icp_tier as never)
    expect(qualAgrees, `qualification: v1=${p.icp_tier} golden=${c.expected.tier}`)
      .toBe(!c.v1Disagrees?.includes('qualification'))
    if (qualAgrees) for (const code of c.expected.reasonCodesPresent ?? []) expect(p.reason_codes).toContain(code)

    const exp = c.expected.routing
    if (!exp) return
    const r = routingAgent.run(buildRoutingInput(c, q))
    const rp = r.parameters as { recommended_owner_id?: string; queue_name: string; reason_codes: string[] }
    const routeAgrees = exp.action === 'assign_owner'
      ? r.type === 'assign_owner' && rp.recommended_owner_id === exp.ownerId && rp.queue_name === exp.queue
      : r.type === 'request_human_review' && rp.reason_codes[0] === exp.reason
    expect(routeAgrees, `routing: v1=${r.type} ${JSON.stringify(rp)}`).toBe(!c.v1Disagrees?.includes('routing'))
  })
})
