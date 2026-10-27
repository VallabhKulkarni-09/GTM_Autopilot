import { randomUUID } from 'crypto'
import { WorkflowState } from '../state.js'
import { getDb } from '../../../db/client.js'
import { executeAction } from '../../../actions/executor.js'
import { validateAction } from '../../../actions/validator.js'
import { writeEvent } from '../../../events/event-log.js'
import { buildDecisionSnapshot } from '../../../evidence/context-builder.js'
import { RoutingAgent } from '../../../agents/routing/index.js'
import { RoutingAgentV2, type RoutingDecisionContext } from '../../../agents/routing/llm.js'
import { chooseRoutingModel } from '../qualification-model.js'
import { SalesforceConnector } from '../../../connectors/salesforce/salesforce.connector.js'
import { getConnectors } from '../../../connectors/factory.js'
import { listReps } from '../../../repositories/reps.repository.js'
import { selectRoutingPolicy } from '../../../policies/routing-policy.js'
import type { RoutingInput } from '../../../agents/routing/types.js'
import type { ProposedAction } from '../../../actions/types.js'
import type { ConnectorRegistry } from '../../../actions/action-executor.js'

export async function route(state: WorkflowState): Promise<Partial<WorkflowState>> {
  const decisionSnapshot = await buildDecisionSnapshot(state as any)

  try {
    // ── 1. Load territory policy rules from snapshot (already fetched) ─────────
    const territoryPolicyRules = (decisionSnapshot.policies ?? []).filter(
      (p: any) => p.rule_type === 'territory'
    )

    // ── 2. Load routing_state for the inbound-leads queue ────────────────────
    const { data: routingStateRow } = await getDb()
      .from('routing_state')
      .select('id, queue_name, counter, updated_at')
      .eq('organization_id', state.organizationId)
      .eq('queue_name', 'inbound-leads')
      .single()

    const routingState = routingStateRow ?? { id: '', queue_name: 'inbound-leads', counter: 0, updated_at: new Date().toISOString() }

    // ── 3. Reps (SF users imported on the Reps page) + the org's capacity limit ──
    // Unavailable reps (PTO/paused) and reps no longer active in Salesforce are
    // passed through with flags so the agent can give a specific reason code.
    const reps = await listReps(state.organizationId)
    const availableOwners = reps.map(r => ({
      Id:          r.external_id,
      Name:        r.metadata?.name ?? '',
      Email:       r.metadata?.email ?? '',
      IsActive:    r.metadata?.sf_active === true,
      IsAvailable: r.metadata?.available === true,
    }))
    const { maxOpenLeadsPerRep } = selectRoutingPolicy(decisionSnapshot.policies ?? [])

    // ── 4. Load company from DB if not in state (Clearbit absent) ─────────────
    let company = state.company ?? null
    if (!company && state.lead?.company_id) {
      const { data: companyData } = await getDb()
        .from('companies')
        .select('*')
        .eq('id', state.lead.company_id)
        .eq('organization_id', state.organizationId)
        .single()
      company = (companyData as any) ?? null
    }

    // Record the company the agent actually routes on (state may hold one the DB lookup didn't find).
    decisionSnapshot.company = company

    // ── 5. Run RoutingAgent ───────────────────────────────────────────────────
    const routingInput: RoutingInput = {
      lead:                state.lead,
      company,
      qualificationResult: state.qualificationResult as any,
      availableOwners,
      ownerWorkloads:      decisionSnapshot.ownerWorkloads,
      territoryPolicyRules,
      routingState:        routingState as any,
      maxOpenLeadsPerRep,
    }
    // v2: the AI may read a free-text company country ("Deutschland" → DE). Territories, availability,
    // capacity and round-robin stay v1 code (routing/llm.ts). Off unless switched on and still gated.
    const choice = await chooseRoutingModel(state.organizationId)
    const v2 = choice.kind === 'on' ? new RoutingAgentV2() : null
    const agent = v2 ?? new RoutingAgent()
    const routingResult = choice.kind === 'on'
      ? await (v2 as RoutingAgentV2).execute(routingInput, { model: choice.client, modelDigest: choice.modelDigest, evaluatedDigest: choice.evaluatedDigest })
      : new RoutingAgent().run(routingInput)
    decisionSnapshot.routingContext = {
      owners: availableOwners,
      roundRobinCounter: (routingState as { counter?: number }).counter ?? 0,
      maxOpenLeadsPerRep,
    }
    const rmc = routingResult.parameters?.model_context as RoutingDecisionContext | undefined
    if (choice.kind !== 'off') {
      decisionSnapshot.routingModelContext = {
        outcome: rmc?.outcome ?? 'fallback',
        provider: rmc?.provider ?? (choice.kind === 'fallback' ? choice.provider : ''),
        model: rmc?.model ?? (choice.kind === 'fallback' ? choice.model : ''),
        reportedModel: rmc?.reportedModel ?? null,
        modelDigest: rmc?.modelDigest ?? null,
        promptVersion: rmc?.promptVersion ?? '',
        temperature: 0,
        evaluationId: choice.evaluationId,
        fallbackReason: choice.kind === 'fallback' ? choice.reason : rmc?.fallbackReason ?? null,
        countryRaw: rmc?.countryRaw ?? null,
        countryCode: rmc?.countryCode ?? null,
      }
      decisionSnapshot.agentName = agent.name
      decisionSnapshot.agentVersion = agent.version
      decisionSnapshot.promptVersion = v2 ? v2.promptVersion : null
      decisionSnapshot.modelName = rmc?.outcome === 'model' ? rmc.model : null
    }
    if (decisionSnapshot.routingModelContext?.outcome === 'fallback') {
      await writeEvent({
        organizationId: state.organizationId,
        workflowRunId:  state.workflowRunId,
        playInstanceId: state.playInstanceId,
        leadId:         state.leadId,
        eventType:      'model_fallback',
        actorType:      'agent',
        actorId:        agent.name,
        agentVersion:   agent.version,
        modelProvider:  decisionSnapshot.routingModelContext.provider || undefined,
        modelName:      decisionSnapshot.routingModelContext.model || undefined,
        promptVersion:  decisionSnapshot.routingModelContext.promptVersion || undefined,
        decisionSnapshot,
        eventStatus:    'skipped',
        errorCode:      decisionSnapshot.routingModelContext.fallbackReason ?? 'MODEL_FALLBACK',
      })
    }

    await writeEvent({
      organizationId: state.organizationId,
      workflowRunId:  state.workflowRunId,
      playInstanceId: state.playInstanceId,
      leadId:         state.leadId,
      eventType:      'action_proposed',
      actorType:      'agent',
      actorId:        agent.name,
      agentVersion:   agent.version,
      modelProvider:  rmc?.outcome === 'model' ? rmc.provider : undefined,
      modelName:      rmc?.outcome === 'model' ? (rmc.reportedModel ?? rmc.model) : undefined,
      promptVersion:  rmc?.outcome === 'model' ? rmc.promptVersion : undefined,
      proposedAction: routingResult as any,
      decisionSnapshot,
      eventStatus:    'success',
    })

    const { approved, requiresHumanApproval } = await validateAction(routingResult as any, state.organizationId)

    // v2: the AI model and the rules disagreed on fit → a person decides (assign a rep, or reject → nurture).
    const fitReview = (state.qualificationResult as { parameters?: { review_required?: unknown } } | null)?.parameters?.review_required
    const fitReviewCode = typeof fitReview === 'string' ? fitReview : null
    // Reviewer sees the fit question, plus the routing problem only if routing itself also failed.
    const reviewCodes = [
      ...(fitReviewCode ? [fitReviewCode] : []),
      ...(!fitReviewCode || routingResult.type === 'request_human_review' ? ((routingResult.parameters?.reason_codes as string[]) ?? []) : []),
    ]

    // ── 5a. Human review path ─────────────────────────────────────────────────
    if (requiresHumanApproval || routingResult.type === 'request_human_review' || fitReviewCode) {
      const humanReviewAction: ProposedAction = {
        actionId:          randomUUID(),
        type:              'request_human_review',
        target:            { leadId: state.leadId, organizationId: state.organizationId },
        rationale:         { reasonCodes: reviewCodes, evidenceIds: [] },
        decisionRiskScore: routingResult.decisionRiskScore ?? 0.0,
        rawConfidence:     routingResult.rawConfidence ?? 1.0,
        parameters:        fitReviewCode
          ? { ...(routingResult.parameters ?? {}), reason_codes: reviewCodes, review_reason: fitReviewCode }
          : routingResult.parameters ?? {},
        idempotencyKey:    `${state.organizationId}:${state.workflowRunId}:request_human_review`,
        constraints:       { requiredPolicyIds: [] },
      }
      await executeAction(humanReviewAction, {} as any, state.organizationId, state.workflowRunId, state.playInstanceId, decisionSnapshot)
      return { routingResult: { ...routingResult, type: 'request_human_review' } as any, currentStep: 'route' }
    }

    // ── 5b. Owner assignment path ─────────────────────────────────────────────
    if (approved && routingResult.type === 'assign_owner') {
      // Workspace's Salesforce, from encrypted per-org credentials.
      // Not connected → null: the executor records the owner without SF sync (output.sf_synced=false).
      // Connected but failing (bad secret, SF down) → throws, so the job retries and the failure is logged.
      const sfConnector: SalesforceConnector | null = await getConnectors(state.organizationId).salesforce()

      const connectors: Partial<ConnectorRegistry> = sfConnector ? { salesforce: sfConnector as any } : {}

      const assignOwnerAction: ProposedAction = {
        actionId:          randomUUID(),
        type:              'assign_owner',
        target:            { leadId: state.leadId, organizationId: state.organizationId },
        rationale:         { reasonCodes: (routingResult.parameters?.reason_codes as string[]) ?? [], evidenceIds: [] },
        decisionRiskScore: routingResult.decisionRiskScore ?? 0.0,
        rawConfidence:     routingResult.rawConfidence ?? 1.0,
        parameters:        routingResult.parameters ?? {},
        idempotencyKey:    `${state.organizationId}:${state.workflowRunId}:assign_owner`,
        constraints:       { requiredPolicyIds: [] },
      }
      await executeAction(assignOwnerAction, connectors as any, state.organizationId, state.workflowRunId, state.playInstanceId, decisionSnapshot)
    }

    return { routingResult: routingResult as any, currentStep: 'route' }
  } catch (e: any) {
    await writeEvent({
      organizationId: state.organizationId,
      workflowRunId:  state.workflowRunId,
      playInstanceId: state.playInstanceId,
      leadId:         state.leadId,
      eventType:      'action_execution_failed',
      actorType:      'system',
      decisionSnapshot,
      eventStatus:    'failed',
      errorMessage:   e.message,
    })
    throw e
  }
}
