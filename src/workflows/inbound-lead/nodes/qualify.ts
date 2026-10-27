import { randomUUID } from 'crypto'
import { WorkflowState } from '../state.js'
import { executeAction } from '../../../actions/executor.js'
import { writeEvent } from '../../../events/event-log.js'
import { buildDecisionSnapshot } from '../../../evidence/context-builder.js'
import { QualificationAgent } from '../../../agents/qualification/index.js'
import { QualificationAgentV2, type ModelDecisionContext } from '../../../agents/qualification/llm.js'
import { chooseQualificationModel } from '../qualification-model.js'
import { getDb } from '../../../db/client.js'
import type { QualificationInput } from '../../../agents/qualification/types.js'
import type { ProposedAction } from '../../../actions/types.js'

export async function qualify(state: WorkflowState): Promise<Partial<WorkflowState>> {
  const decisionSnapshot = await buildDecisionSnapshot(state as any)

  // Load company from DB if not already in state (e.g. when Clearbit is absent
  // but company was pre-seeded or loaded via another enrichment source).
  let company = state.company ?? null
  if (!company && state.lead?.company_id) {
    const { data } = await getDb()
      .from('companies')
      .select('*')
      .eq('id', state.lead.company_id)
      .eq('organization_id', state.organizationId)
      .single()
    company = (data as any) ?? null
  }

  // Record the company the agent actually scores (state may hold one the DB lookup didn't find).
  decisionSnapshot.company = company

  try {
    const input: QualificationInput = {
      lead: state.lead,
      company,
      enrichmentEvidence: state.evidence,
      // The ICP policy is taken from the same policy rows recorded in the decision
      // snapshot, so the audit trail shows exactly the config that scored this lead.
      // QualificationAgent throws ICP_POLICY_MISSING if the org has none.
      icpPolicyRules: decisionSnapshot.policies.filter(p => p.rule_type === 'icp_filter'),
    }
    // v2: the AI agent runs only when switched on and its golden-set run still matches (qualification-model.ts).
    const choice = await chooseQualificationModel(state.organizationId)
    const v2 = choice.kind === 'on' ? new QualificationAgentV2() : null
    const agent = v2 ?? new QualificationAgent()
    const qualificationResult = choice.kind === 'on'
      ? await (v2 as QualificationAgentV2).execute(input, { model: choice.client, modelDigest: choice.modelDigest, evaluatedDigest: choice.evaluatedDigest })
      : new QualificationAgent().run(input)

    const mc = qualificationResult.parameters.model_context as ModelDecisionContext | undefined
    if (choice.kind !== 'off') {
      decisionSnapshot.modelContext = {
        outcome: mc?.outcome ?? 'fallback',
        provider: mc?.provider ?? (choice.kind === 'fallback' ? choice.provider : ''),
        model: mc?.model ?? (choice.kind === 'fallback' ? choice.model : ''),
        reportedModel: mc?.reportedModel ?? null,
        modelDigest: mc?.modelDigest ?? null,
        promptVersion: mc?.promptVersion ?? (v2?.promptVersion ?? ''),
        temperature: 0,
        evaluationId: choice.evaluationId,
        fallbackReason: choice.kind === 'fallback' ? choice.reason : mc?.fallbackReason ?? null,
        rulesTier: mc?.rulesTier ?? (qualificationResult.parameters.icp_tier as 'tier_1' | 'tier_2' | 'not_icp'),
        modelTier: mc?.modelTier ?? null,
      }
      decisionSnapshot.agentName = agent.name
      decisionSnapshot.agentVersion = agent.version
      decisionSnapshot.promptVersion = v2 ? v2.promptVersion : null
      decisionSnapshot.modelName = mc?.outcome === 'model' ? mc.model : null
    }

    // Never silent: if the model was meant to decide but the rules did, say so on the timeline.
    if (decisionSnapshot.modelContext?.outcome === 'fallback') {
      await writeEvent({
        organizationId: state.organizationId,
        workflowRunId: state.workflowRunId,
        playInstanceId: state.playInstanceId,
        leadId: state.leadId,
        eventType: 'model_fallback',
        actorType: 'agent',
        actorId: agent.name,
        agentVersion: agent.version,
        modelProvider: decisionSnapshot.modelContext.provider || undefined,
        modelName: decisionSnapshot.modelContext.model || undefined,
        promptVersion: decisionSnapshot.modelContext.promptVersion || undefined,
        decisionSnapshot,
        eventStatus: 'skipped',
        errorCode: decisionSnapshot.modelContext.fallbackReason ?? 'MODEL_FALLBACK',
      })
    }
    const icpPolicyId = qualificationResult.parameters.icp_policy_id as string
    decisionSnapshot.icpPolicy = {
      id: icpPolicyId,
      version: qualificationResult.parameters.icp_policy_version as number,
    }

    await writeEvent({
      organizationId: state.organizationId,
      workflowRunId: state.workflowRunId,
      playInstanceId: state.playInstanceId,
      leadId: state.leadId,
      eventType: 'action_proposed',
      actorType: 'agent',
      actorId: agent.name,
      agentVersion: agent.version,
      modelProvider: mc?.outcome === 'model' ? mc.provider : undefined,
      modelName: mc?.outcome === 'model' ? (mc.reportedModel ?? mc.model) : undefined,
      promptVersion: mc?.outcome === 'model' ? mc.promptVersion : undefined,
      proposedAction: qualificationResult as any,
      decisionSnapshot,
      eventStatus: 'success'
    })

    const action: ProposedAction = {
      actionId: randomUUID(),
      type: 'qualify_lead',
      target: { leadId: state.leadId, organizationId: state.organizationId },
      rationale: {
        reasonCodes: (qualificationResult.parameters?.reason_codes as string[]) ?? [],
        evidenceIds: state.evidence.map((e: any) => e.id ?? '').filter(Boolean),
      },
      decisionRiskScore: qualificationResult.decisionRiskScore ?? 0.0,
      rawConfidence: qualificationResult.rawConfidence ?? 1.0,
      parameters: qualificationResult.parameters ?? {},
      idempotencyKey: `${state.organizationId}:${state.workflowRunId}:qualify_lead`,
      constraints: { requiredPolicyIds: [icpPolicyId] },
    }

    await executeAction(action, {} as any, state.organizationId, state.workflowRunId, state.playInstanceId, decisionSnapshot)

    return { qualificationResult: qualificationResult as any, currentStep: 'qualify' }
  } catch (e: any) {
    await writeEvent({
      organizationId: state.organizationId,
      workflowRunId: state.workflowRunId,
      playInstanceId: state.playInstanceId,
      leadId: state.leadId,
      eventType: 'action_execution_failed',
      actorType: 'system',
      decisionSnapshot,
      eventStatus: 'failed',
      errorMessage: e.message
    })
    throw e
  }
}
