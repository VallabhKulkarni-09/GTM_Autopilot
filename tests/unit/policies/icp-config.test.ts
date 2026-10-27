import { describe, it, expect } from 'vitest'
import { parseIcpConfig, IcpConfigError, DEFAULT_ICP_CONFIG } from '../../../src/agents/qualification/icp-config'
import { DEFAULT_POLICIES } from '../../../src/policies/default-policies'

describe('parseIcpConfig', () => {
  it('accepts the defaults unchanged', () => {
    expect(parseIcpConfig(DEFAULT_ICP_CONFIG)).toEqual(DEFAULT_ICP_CONFIG)
  })

  it('normalises case, trims and de-duplicates lists', () => {
    const c = parseIcpConfig({ ...DEFAULT_ICP_CONFIG, industries: [' SaaS ', 'saas'], countries: ['us', 'US'], title_keywords: ['VP'] })
    expect(c.industries).toEqual(['saas'])
    expect(c.countries).toEqual(['US'])
    expect(c.title_keywords).toEqual(['vp'])
  })

  it.each([
    ['missing field', (() => { const { countries: _c, ...r } = DEFAULT_ICP_CONFIG; return r })(), 'countries'],
    ['bad country code', { ...DEFAULT_ICP_CONFIG, countries: ['USA'] }, '2-letter'],
    ['sizes out of order', { ...DEFAULT_ICP_CONFIG, employee_min: 2000 }, 'in order'],
    ['weight over 100', { ...DEFAULT_ICP_CONFIG, weights: { ...DEFAULT_ICP_CONFIG.weights, industry: 150 } }, 'weights.industry'],
    ['tier_2 above tier_1', { ...DEFAULT_ICP_CONFIG, tier_thresholds: { tier_1: 40, tier_2: 60 } }, 'Good fit'],
    ['empty keyword', { ...DEFAULT_ICP_CONFIG, intent_keywords: ['  '] }, 'intent_keywords'],
    ['gate not boolean', { ...DEFAULT_ICP_CONFIG, block_free_email: 'yes' }, 'block_free_email'],
  ])('rejects %s', (_name, raw, fragment) => {
    let err: unknown
    try { parseIcpConfig(raw) } catch (e) { err = e }
    expect(err).toBeInstanceOf(IcpConfigError)
    expect((err as IcpConfigError).message).toContain(fragment)
  })

  it('is seeded for new workspaces', () => {
    const seed = DEFAULT_POLICIES.find(p => p.rule_type === 'icp_filter')
    expect(seed).toBeDefined()
    expect(parseIcpConfig(seed!.conditions)).toEqual(DEFAULT_ICP_CONFIG)
  })
})
