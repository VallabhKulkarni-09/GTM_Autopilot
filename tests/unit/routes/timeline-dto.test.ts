import { describe, it, expect } from 'vitest'
import { toTimelineEventDto } from '../../../src/routes/api/timeline-dto.js'

const row = {
  id: 'ev1', organization_id: 'org-a', workflow_run_id: 'wr', play_instance_id: 'p', lead_id: 'l',
  event_type: 'action_proposed', actor_type: 'agent', actor_id: 'qualification-agent', agent_version: '2.0.1',
  model_provider: 'gemini', model_name: 'gemini-3.5-flash-lite', prompt_version: 'qualification-v2.2',
  proposed_action: { type: 'qualify_lead' }, candidate_actions: [{ secret: 1 }], policy_rule_id: 'r', policy_name: null,
  policy_passed: null, policy_decision: null, external_system: null, external_id: null, idempotency_key: 'k',
  event_status: 'success', error_code: null, error_message: null, error_raw: { token: 'raw-provider-body' }, duration_ms: 5,
  occurred_at: 't', created_at: 't',
  decision_snapshot: {
    lead: { email: 'person@acme.example', phone: '+1 555', raw_payload: { message: 'hi' } },
    company: { name: 'Acme', industry: 'SaaS', employee_count: 200, country: 'US', raw_clearbit: { big: true }, domain: 'acme.example' },
    policies: [{ id: 'p1', rule_type: 'icp_filter', name: 'ICP', version: 3, conditions: { weights: {} }, organization_id: 'org-a' }],
    ownerWorkloads: { rep: 4 }, evidenceIds: ['e1'], agentName: 'qualification-agent', agentVersion: '2.0.1',
    promptVersion: 'qualification-v2.2', modelName: 'gemini-3.5-flash-lite', icpPolicy: { id: 'p1', version: 3 },
    routingContext: { owners: [{ Id: '005', Email: 'rep@acme.example' }] },
    modelContext: { outcome: 'model', provider: 'gemini', model: 'gemini-3.5-flash-lite', judgements: { title: 'yes' } },
  },
}

describe('timeline DTO', () => {
  it('keeps what the lead page reads and drops raw data', () => {
    const dto = toTimelineEventDto(row as never)
    const json = JSON.stringify(dto)
    for (const leaked of ['org-a', 'raw-provider-body', 'person@acme.example', '+1 555', 'raw_clearbit', 'rep@acme.example', 'weights', 'secret', 'ownerWorkloads']) {
      expect(json, leaked).not.toContain(leaked)
    }
    expect(dto).toMatchObject({ id: 'ev1', event_type: 'action_proposed', model_name: 'gemini-3.5-flash-lite', idempotency_key: 'k' })
    expect(dto.decision_snapshot).toMatchObject({
      agentName: 'qualification-agent', icpPolicy: { id: 'p1', version: 3 }, evidenceIds: ['e1'],
      company: { name: 'Acme', industry: 'SaaS', employee_count: 200, country: 'US', domain: 'acme.example' },
      policies: [{ id: 'p1', rule_type: 'icp_filter', name: 'ICP', version: 3 }],
      modelContext: { outcome: 'model', provider: 'gemini' },
    })
  })

  it('handles a null company and a missing snapshot', () => {
    expect(toTimelineEventDto({ ...row, decision_snapshot: { ...row.decision_snapshot, company: null } } as never).decision_snapshot.company).toBeNull()
    expect(toTimelineEventDto({ ...row, decision_snapshot: null } as never).decision_snapshot).toEqual({})
  })
})
