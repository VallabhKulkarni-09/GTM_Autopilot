/**
 * E2E stub: plays both Supabase Auth (GET /auth/v1/user) and the backend API (/api/*).
 * Lets Playwright run the real dashboard (middleware, proxy, pages) without live services.
 * The role of the signed-in user is chosen per test with the `x-test-role` cookie
 * value forwarded as the bearer token ("admin" | "member").
 */
import http from 'node:http'

const PORT = Number(process.env.STUB_PORT ?? 3199)
const state = { connectorPosts: [], icpPuts: [], icpPreviews: [], repCalls: [], outreachPuts: [], decisions: [], testLeadPosts: [], testLeads: [], testLeadsSent: 0, setupCompleted: {}, aiModelCalls: [] }
// Setup wizard: a token containing "setup" has unfinished setup; "ready" means every required step is done.
const setupStatus = auth => {
  const ready = auth.includes('ready')
  const steps = [
    { key: 'hubspot', required: true, done: true, facts: { status: 'connected' } },
    { key: 'salesforce', required: true, done: ready, facts: { status: ready ? 'connected' : 'not_connected' } },
    { key: 'apollo', required: false, done: false, facts: { status: 'needs_attention' } },
    { key: 'reps', required: true, done: true, facts: { reps: 3, takingLeads: 2 } },
    { key: 'ideal_customer', required: false, done: false, facts: { exists: true, version: 1 } },
    { key: 'outreach', required: false, done: false, facts: { valid: true, tiersChosen: 1, tiers: 2 } },
    { key: 'test_lead', required: true, done: ready || state.testLeadsSent > 0, facts: { sent: ready ? 1 : state.testLeadsSent } },
  ]
  return { completedAt: state.setupCompleted[auth] ?? null, canFinish: steps.every(s => !s.required || s.done), steps }
}
// Approvals: one routing review with no suggestion, one sequence review, one where another admin already decided
const PLAY_ROUTING = '55555555-5555-4555-8555-555555555555'
const PLAY_SEQUENCE = '66666666-6666-4666-8666-666666666666'
const PLAY_DECIDED = '77777777-7777-4777-8777-777777777777'
const ago = min => new Date(Date.now() - min * 60_000).toISOString()
const approvals = () => [
  { playId: PLAY_ROUTING, leadId: 'lead-r', lead: { name: 'Ana Lee', email: 'ana@emea.example', title: 'VP Sales', company: 'Emea Co' },
    kind: 'routing', reasonCodes: ['NO_TERRITORY_MATCH'], suggestedOwner: null, sequenceName: null,
    waitingSince: ago(30), responseDeadline: ago(15), slaBreached: true, decision: null },
  { playId: PLAY_SEQUENCE, leadId: 'lead-s', lead: { name: 'Ben Ode', email: 'ben@acme.example', title: null, company: 'Acme' },
    kind: 'sequence', reasonCodes: ['OUTREACH_ENROLL'], suggestedOwner: null, sequenceName: 'Inbound – Great fit',
    waitingSince: ago(5), responseDeadline: ago(-10), slaBreached: false, decision: null },
  { playId: PLAY_DECIDED, leadId: 'lead-d', lead: { name: 'Cy Park', email: 'cy@x.example', title: null, company: null },
    kind: 'routing', reasonCodes: ['ALL_REPS_AT_CAPACITY'], suggestedOwner: 'Alice Ng', sequenceName: null,
    waitingSince: ago(60), responseDeadline: ago(45), slaBreached: true, decision: null },
]
const attention = () => ({
  awaitingReview: { total: 3, items: approvals().map(a => ({ playId: a.playId, leadId: a.leadId, leadName: a.lead.name, since: a.waitingSince, reason: null })) },
  slaBreached:    { total: 1, items: [{ playId: PLAY_ROUTING, leadId: 'lead-r', leadName: 'Ana Lee', since: ago(15), reason: 'SLA_BREACHED' }] },
  escalated:      { total: 1, items: [{ playId: 'p-e', leadId: 'lead-e', leadName: 'Dee Fox', since: ago(2), reason: 'OUTREACH_TIER_NOT_SET' }] },
})
// Outreach: role "admin" → Apollo connected; a cookie/token containing "noapollo" → not connected
const OUTREACH = {
  email_account: null,
  tiers: { tier_1: null, tier_2: { mode: 'manual' } },
}
const outreachOptions = {
  sequences: [
    { id: 'seq-great', name: 'Inbound – Great fit', active: true },
    { id: 'seq-old', name: 'Old webinar follow-up', active: false },
  ],
  emailAccounts: [
    { id: 'acct-1', email: 'sdr@acme.com', active: true, isDefault: true },
    { id: 'acct-2', email: 'old@acme.com', active: false, isDefault: false },
  ],
}
const REP_A = '11111111-1111-4111-8111-111111111111'
const REP_B = '22222222-2222-4222-8222-222222222222'
const reps = () => [
  { id: REP_A, name: 'Alice Ng', email: 'alice@acme.com', title: 'AE', available: true, activeInSalesforce: true },
  { id: REP_B, name: 'Bob Ruiz', email: 'bob@acme.com', title: null, available: false, activeInSalesforce: true },
]
const territories = () => [
  { id: '33333333-3333-4333-8333-333333333333', name: 'North America', countries: ['US', 'CA'], repIds: [REP_A], missingReps: 0, priority: 10 },
  { id: '44444444-4444-4444-8444-444444444444', name: 'Everywhere', countries: null, repIds: null, missingReps: 0, priority: 1000 },
]

const ICP = {
  industries: ['saas', 'software'], countries: ['US', 'GB'],
  employee_floor: 10, employee_near_min: 50, employee_min: 100, employee_max: 1000,
  title_keywords: ['vp'], intent_keywords: ['demo'], block_free_email: true,
  weights: { company_size: 30, company_size_near: 15, company_size_large: 20, industry: 25, country: 20, intent: 15, title: 10 },
  tier_thresholds: { tier_1: 70, tier_2: 45 },
}

function connectors() {
  return [
    { name: 'hubspot', status: 'connected', details: { portal_id: '4242' }, lastChecked: '2026-10-25T10:00:00Z' },
    { name: 'salesforce', status: 'not_connected', details: {}, lastChecked: null },
    { name: 'apollo', status: 'needs_attention', details: {}, lastChecked: '2026-10-25T10:00:00Z' },
  ]
}

// Lead detail / timeline: one assigned lead with a full history, one with no events yet,
// one paused for review that also carries an event type this dashboard build doesn't know.
const LEAD_ASSIGNED = '88888888-8888-4888-8888-888888888888'
const LEAD_EMPTY = '99999999-9999-4999-8999-999999999999'
const LEAD_PAUSED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LEAD_TEST = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const leadRow = (id, over = {}) => ({
  id, email: 'jo@acme.example', name: 'Jo Rivera', firstName: 'Jo', lastName: 'Rivera', title: 'VP Sales', phone: null,
  stage: 'routing', source: 'demo-request', formSubmittedAt: ago(4), isDuplicate: false, isIcpFit: true, icpScore: 85, icpTier: 'tier_1',
  isTest: false, createdAt: ago(4), ...over,
})
const playRow = over => ({
  id: 'play-1', status: 'running', current_step: 4, sla_breached: false, first_touch_at: null, first_touch_deadline: ago(-11),
  workflow_run_id: 'run-1', outcome_status: 'no_outcome_yet', outcome_detected_at: null, late_meeting_flag: false,
  meetings_count_in_window: 0, attribution_window_days: 30, ...over,
})
let seq = 0
const ev = (type, over = {}) => ({
  id: `ev-${++seq}`, occurred_at: new Date(Date.now() - 240_000 + seq * 1000).toISOString(), event_type: type,
  actor_type: 'system', actor_id: null, agent_version: null, model_name: null, prompt_version: null,
  workflow_run_id: 'run-1', play_instance_id: 'play-1',
  decision_snapshot: { lead: {}, company: { name: 'Acme Corp' }, policies: [{ rule_type: 'icp_filter', name: 'Ideal customer', version: 4 }], ownerWorkloads: {}, evidenceIds: [], agentName: 'test', agentVersion: '1.0.0', promptVersion: null, modelName: null },
  proposed_action: null, policy_name: null, policy_passed: null, policy_decision: null,
  external_system: null, external_id: null, idempotency_key: null, event_status: 'success',
  error_code: null, error_message: null, duration_ms: null, ...over,
})
const action = (type, key, parameters, reasonCodes = []) => ({ actionId: key, type, parameters, rationale: { reasonCodes, evidenceIds: [] }, idempotencyKey: `org:run-1:${key}` })
function assignedTimeline() {
  seq = 0
  const qualify = action('qualify_lead', 'qualify', { icp_tier: 'tier_1', icp_score: 85, is_icp_fit: true }, ['ICP_COMPANY_SIZE_IN_RANGE', 'ICP_SENIOR_TITLE'])
  const assign = action('assign_owner', 'assign', { recommended_owner_name: 'Alice Ng', queue_name: 'north-america' }, ['TERRITORY_NORTH_AMERICA', 'ROUND_ROBIN_SELECTED'])
  const outreach = action('start_sequence', 'start_sequence', { provider: 'apollo', plan: 'not_configured', tier: 'tier_1', reason_code: 'OUTREACH_TIER_NOT_SET' }, ['OUTREACH_TIER_NOT_SET'])
  return [
    ev('webhook_received', { actor_type: 'webhook' }),
    ev('enrichment_skipped', { event_status: 'skipped', decision_snapshot: { enrichmentSkipReason: 'not_configured' } }),
    ev('dedup_passed'),
    ev('action_proposed', { actor_type: 'agent', actor_id: 'qualification-agent', proposed_action: qualify }),
    ev('action_execution_started', { idempotency_key: qualify.idempotencyKey, proposed_action: qualify }),
    ev('action_execution_succeeded', { idempotency_key: qualify.idempotencyKey }),
    ev('action_proposed', { actor_type: 'agent', actor_id: 'routing-agent', proposed_action: assign }),
    ev('action_execution_started', { idempotency_key: assign.idempotencyKey, proposed_action: assign }),
    ev('action_execution_succeeded', { idempotency_key: assign.idempotencyKey, external_system: 'salesforce', external_id: '00T5g00000TASK1' }),
    ev('action_proposed', { actor_type: 'agent', actor_id: 'first-touch', idempotency_key: outreach.idempotencyKey, proposed_action: outreach }),
    ev('action_execution_started', { idempotency_key: outreach.idempotencyKey, proposed_action: outreach }),
    ev('action_execution_failed', { idempotency_key: outreach.idempotencyKey, event_status: 'failed', error_code: 'OUTREACH_TIER_NOT_SET', error_message: 'No sequence chosen' }),
    ev('escalation_sent', { actor_id: 'escalate-worker', policy_decision: { channel: 'in_app', reason: 'OUTREACH_TIER_NOT_SET' } }),
  ]
}
function pausedTimeline() {
  seq = 0
  const review = action('request_human_review', 'review', { queue_name: 'unassigned', reason_codes: ['NO_TERRITORY_MATCH'] }, ['NO_TERRITORY_MATCH'])
  return [
    ev('webhook_received', { actor_type: 'webhook' }),
    ev('action_proposed', { actor_type: 'agent', actor_id: 'routing-agent', proposed_action: review }),
    ev('action_execution_started', { idempotency_key: review.idempotencyKey, proposed_action: review }),
    ev('action_execution_succeeded', { idempotency_key: review.idempotencyKey }),
    ev('brand_new_step_type'),
  ]
}
const leadDetail = {
  [LEAD_ASSIGNED]: () => ({ lead: leadRow(LEAD_ASSIGNED), currentPlay: playRow(), timeline: assignedTimeline() }),
  [LEAD_EMPTY]:    () => ({ lead: leadRow(LEAD_EMPTY, { name: 'New Person', stage: 'new', icpScore: null, icpTier: null, isIcpFit: null, formSubmittedAt: ago(0) }), currentPlay: null, timeline: [] }),
  [LEAD_TEST]:     () => { seq = 0; return { lead: leadRow(LEAD_TEST, { name: 'Test Lead', isTest: true }), currentPlay: playRow(), timeline: [ev('webhook_received', { actor_type: 'human', actor_id: 'u' })] } },
  [LEAD_PAUSED]:   () => ({ lead: leadRow(LEAD_PAUSED, { name: 'Pat Kim', icpTier: 'tier_2', icpScore: 55 }), currentPlay: playRow({ status: 'paused' }), timeline: pausedTimeline() }),
}

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }

http.createServer(async (req, res) => {
  const auth = req.headers.authorization ?? ''
  const role = auth.includes('member') ? 'member' : 'admin'
  let body = ''
  for await (const chunk of req) body += chunk

  if (req.url.startsWith('/auth/v1/user')) {
    return json(res, 200, { id: '00000000-0000-0000-0000-00000000000a', aud: 'authenticated', role: 'authenticated', email: `${role}@example.com`, app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' })
  }
  if (req.url === '/__state') return json(res, 200, state)
  if (req.url === '/api/me') {
    const setupCompleted = !auth.includes('setup') || Boolean(state.setupCompleted[auth])
    return json(res, 200, { user: { id: 'u', email: `${role}@example.com` }, workspace: { id: 'w', name: 'Acme Sales', setupCompleted }, role })
  }
  if (req.url === '/api/setup' && req.method === 'GET') return json(res, 200, setupStatus(auth))
  if (req.url === '/api/setup/complete' && req.method === 'POST') {
    const s = setupStatus(auth)
    if (!s.canFinish) return json(res, 409, { error: 'SETUP_INCOMPLETE', message: 'Finish these steps first: Connect Salesforce, Send a test lead.' })
    state.setupCompleted[auth] = '2026-10-26T12:00:00Z'
    return json(res, 200, { completedAt: state.setupCompleted[auth] })
  }
  if (req.url === '/api/test-lead') {
    if (req.method === 'GET') return json(res, 200, { leads: state.testLeads })
    if (req.method === 'POST') {
      const b = JSON.parse(body || '{}')
      state.testLeadPosts.push({ ...b, auth })
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email ?? '')) return json(res, 400, { error: 'FST_ERR_VALIDATION', message: 'body/email must match format "email"' })
      const submittedAt = new Date().toISOString()
      state.testLeadsSent++
      // Arrives as if the worker processed it (Postgres-style offset, not "Z")
      state.testLeads.unshift({ id: LEAD_TEST, name: [b.firstName, b.lastName].filter(Boolean).join(' ') || b.email, email: b.email,
        stage: 'routing', fit: 'tier_1', submittedAt: submittedAt.replace('Z', '+00:00'), playStatus: 'running', owner: 'Alice Ng' })
      return json(res, 202, { status: 'queued', email: b.email, submittedAt })
    }
    if (req.method === 'DELETE') {
      const removed = state.testLeads.length
      state.testLeads = []
      return json(res, 200, { removed })
    }
  }
  if (req.url.startsWith('/api/ai-model')) {
    const b = body ? JSON.parse(body) : null
    if (req.method !== 'GET') state.aiModelCalls.push({ method: req.method, url: req.url, body: b, auth })
    const ai = auth.includes('aimodel')
    const evalDone = { id: 'ev1', status: 'completed', provider: 'ollama', model: 'qwen2.5:1.5b', modelDigest: 'd', promptVersion: 'p', agentVersion: '2.0.0', datasetVersion: 'x',
      summary: { agreed: 30, total: 45, injection: { agreed: 3, total: 4 }, reviews: 6, fallbacks: 2, hardGates: 5, errors: 0, avgModelLatencyMs: 9800, baseline: { agreed: 39, total: 45 }, routing: { agreed: 19, total: 20, asked: 6, fallbacks: 0, baseline: { agreed: 15, total: 20 } } },
      error: null, startedAt: 's', completedAt: 'c',
      misses: [{ caseId: 'perfect-fit', description: 'Every signal present', expected: 'tier_1', actual: 'tier_2', outcome: 'model', review: false, fallbackReason: null }], routingMisses: [] }
    if (ai && req.url === '/api/ai-model/evaluations/latest') {
      state.aiPolls = (state.aiPolls ?? 0) + 1
      if (!state.aiRunStarted) return json(res, 200, { evaluation: null, matchesCurrentModel: false, qualificationAgentEnabled: false })
      const finished = state.aiPolls > 2
      return json(res, 200, { evaluation: finished ? evalDone : { ...evalDone, status: 'running', summary: { done: 12, total: 45 }, misses: [] }, matchesCurrentModel: finished, routingMatchesCurrentModel: finished, qualificationAgentEnabled: Boolean(state.aiAgentOn), routingAgentEnabled: Boolean(state.aiRoutingOn) })
    }
    if (ai && req.url === '/api/ai-model/evaluations' && req.method === 'POST') { state.aiRunStarted = true; state.aiPolls = 0; return json(res, 202, { evaluation: { ...evalDone, status: 'running' } }) }
    if (ai && req.url === '/api/ai-model/agents' && req.method === 'PUT') { if ('qualification' in b) state.aiAgentOn = b.qualification; if ('routing' in b) state.aiRoutingOn = b.routing; return json(res, 200, { qualificationAgentEnabled: Boolean(state.aiAgentOn), routingAgentEnabled: Boolean(state.aiRoutingOn) }) }
    if (ai && req.method === 'GET') return json(res, 200, { configured: true, provider: 'ollama', baseUrl: 'http://host.docker.internal:11434', model: 'qwen2.5:1.5b', hasApiKey: false, qualificationAgentEnabled: false, dataLeavesMachine: false, consentAt: null, lastTest: { ok: true, at: '2026-10-27T10:00:00Z' }, suggestedOllamaUrl: null })
    if (req.method === 'GET') return json(res, 200, { configured: false, provider: null, baseUrl: null, model: null, hasApiKey: false, dataLeavesMachine: false, consentAt: null, lastTest: null, suggestedOllamaUrl: 'http://host.docker.internal:11434' })
    if (req.url === '/api/ai-model/models') return json(res, 200, b.baseUrl?.includes('nowhere')
      ? { ok: false, error: 'MODEL_UNREACHABLE', message: 'Could not reach the model server.', fix: 'Check the address and that the server is running.' }
      : { ok: true, models: ['llama3.2:1b', 'qwen2.5:1.5b'] })
    if (req.url === '/api/ai-model/test') return json(res, 200, { ok: true, latencyMs: 1062, reportedModel: b.model, digest: 'sha', jsonOk: false })
    const publicLocal = b?.provider === 'openai_compatible' && /googleapis|openai\.com/.test(b.baseUrl ?? '')
    if (req.method === 'PUT' && publicLocal && b.consent !== true) return json(res, 400, { error: 'CONSENT_REQUIRED', message: 'This server address is on the internet, not your own network. Confirm that lead details will be sent to it before saving.' })
    if (req.method === 'PUT' && !['ollama', 'openai_compatible'].includes(b.provider) && b.consent !== true) return json(res, 400, { error: 'CONSENT_REQUIRED', message: 'Confirm first.' })
    if (req.method === 'PUT') return json(res, 200, { ok: true, saved: true, latencyMs: 800, reportedModel: b.model, digest: null, jsonOk: true })
  }
  if (req.url === '/api/connectors' && req.method === 'GET') return json(res, 200, connectors())
  if (req.url === '/api/policies') return json(res, 200, [])
  if (req.url === '/api/icp' && req.method === 'GET') return json(res, 200, { id: 'icp-1', version: 4, updatedAt: '2026-10-25T10:00:00Z', config: ICP })
  if (req.url === '/api/icp' && req.method === 'PUT') {
    const b = JSON.parse(body || '{}')
    state.icpPuts.push({ ...b, auth })
    if (b.config.tier_thresholds.tier_2 > b.config.tier_thresholds.tier_1) {
      return json(res, 400, { error: 'ICP_CONFIG_INVALID', message: 'Invalid', issues: ['the "Good fit" score cannot be higher than the "Great fit" score'] })
    }
    return json(res, 200, { id: 'icp-1', version: b.version + 1, updatedAt: '2026-10-26T10:00:00Z', config: b.config })
  }
  if (req.url === '/api/icp/preview' && req.method === 'POST') {
    const b = JSON.parse(body || '{}')
    state.icpPreviews.push(b)
    if ((b.lead.email ?? '').endsWith('@gmail.com')) return json(res, 200, { icp_score: 0, icp_tier: 'not_icp', is_icp_fit: false, fit_label: 'Not a fit', reason_codes: ['DISQUALIFIED_FREE_EMAIL_PROVIDER'] })
    return json(res, 200, { icp_score: 85, icp_tier: 'tier_1', is_icp_fit: true, fit_label: 'Great fit', reason_codes: ['ICP_COMPANY_SIZE_IN_RANGE', 'ICP_INDUSTRY_SAAS'] })
  }
  if (req.url === '/api/reps' && req.method === 'GET') return json(res, 200, { reps: reps() })
  if (req.url === '/api/reps/settings' && req.method === 'GET') return json(res, 200, { version: 2, maxOpenLeadsPerRep: 25 })
  if (req.url === '/api/territories' && req.method === 'GET') return json(res, 200, { territories: territories() })
  if (req.url.startsWith('/api/reps') || req.url.startsWith('/api/territories')) {
    const b = body ? JSON.parse(body) : null
    state.repCalls.push({ method: req.method, url: req.url, body: b, auth })
    if (req.url === '/api/reps/import') return json(res, 200, { added: 1, updated: 2, deactivated: 0, reps: reps() })
    if (req.url === '/api/reps/settings') return json(res, 200, { version: 3, maxOpenLeadsPerRep: b.maxOpenLeadsPerRep })
    if (req.method === 'PATCH') return json(res, 200, { ...reps()[0], available: b.available })
    if (req.method === 'POST' && b?.name === 'EMEA') return json(res, 400, { error: 'TERRITORY_NAME_TAKEN', message: 'There is already a territory called "EMEA".' })
    if (req.method === 'POST') return json(res, 201, { id: 'new', ...b, missingReps: 0, priority: 20 })
    if (req.method === 'DELETE') { res.writeHead(204); return res.end() }
    return json(res, 200, b)
  }
  if (req.url === '/api/metrics/overview') {
    const period = { touchedUnder15MinPct: 80, avgFirstTouchMin: 9, slaBreaches: 1, activePlays: 4, playsCompleted: 10, totalQualified: 12, meeting_rate: null }
    return json(res, 200, { currentPeriod: period, priorPeriod: period })
  }
  if (req.url === '/api/metrics/speed-to-lead') {
    const b = { count: 0, pct: 0 }
    return json(res, 200, { buckets: { under5: b, under15: b, under30: b, under60: b, over60: b }, sdrStats: [], total: 0 })
  }
  const lm = req.url.match(/^\/api\/leads\/([0-9a-f-]+)(\/timeline)?$/)
  if (lm && req.method === 'GET') {
    const make = leadDetail[lm[1]]
    if (!make) return json(res, 404, { error: 'NOT_FOUND', message: 'Lead not found', requestId: 'r' })
    const d = make()
    return lm[2] ? json(res, 200, d.timeline) : json(res, 200, { lead: d.lead, currentPlay: d.currentPlay })
  }
  if (req.url === '/api/attention') return json(res, 200, attention())
  if (req.url === '/api/approvals') return json(res, 200, { total: approvals().length, approvals: approvals() })
  const pm = req.url.match(/^\/api\/plays\/([0-9a-f-]+)\/(approve|reject)$/)
  if (pm && req.method === 'POST') {
    const b = body ? JSON.parse(body) : {}
    state.decisions.push({ playId: pm[1], action: pm[2], body: b, auth })
    if (pm[1] === PLAY_DECIDED) return json(res, 409, { error: 'REVIEW_ALREADY_DECIDED', message: 'Someone already rejected this lead.' })
    return json(res, 202, { status: 'resuming', alreadyDecided: false })
  }
  if (req.url === '/api/outreach' && req.method === 'GET') return json(res, 200, { id: 'pol-out', version: 5, config: OUTREACH })
  if (req.url === '/api/outreach' && req.method === 'PUT') {
    const b = JSON.parse(body || '{}')
    state.outreachPuts.push({ ...b, auth })
    const usesSequence = Object.values(b.config.tiers).some(t => t?.mode === 'sequence')
    if (usesSequence && !b.config.email_account) {
      return json(res, 400, { error: 'OUTREACH_POLICY_INVALID', message: 'Some outreach settings are not valid.', issues: ['pick the mailbox Apollo should send from'] })
    }
    return json(res, 200, { id: 'pol-out', version: b.version + 1, config: b.config })
  }
  if (req.url === '/api/outreach/options') {
    if (auth.includes('noapollo')) return json(res, 409, { error: 'APOLLO_NOT_CONNECTED', message: 'Connect Apollo on the Connections page first.' })
    return json(res, 200, outreachOptions)
  }
  const m = req.url.match(/^\/api\/connectors\/(\w+)\/(test|save)$/)
  if (m && req.method === 'POST') {
    const values = JSON.parse(body || '{}')
    state.connectorPosts.push({ name: m[1], kind: m[2], values, auth })
    if (values.apiKey === 'bad') {
      return json(res, 200, { ok: false, error: 'AP_AUTH_FAILED', message: 'Apollo did not accept the API key.', fix: 'In Apollo → Settings → Integrations → API, create a key and paste it here.' })
    }
    return json(res, 200, { ok: true, latencyMs: 3, saved: m[2] === 'save', details: {} })
  }
  json(res, 404, { error: 'NOT_FOUND', message: req.url })
}).listen(PORT, () => console.log(`stub listening on ${PORT}`))
