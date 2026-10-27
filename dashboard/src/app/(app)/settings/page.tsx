import Link from 'next/link'
import { apiFetch, getMe } from '@/lib/api'
import { getServerToken } from '@/lib/auth'
import { AiModelEvaluationState, AiModelSettings, ConnectorHealth, PolicyRule } from '@/types/api'
import { SlaForm } from './sla-form'
import { ConnectionCard } from './connection-card'
import { AiModelCard } from './ai-model-card'
import { AlertTriangle } from 'lucide-react'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  let connectors: ConnectorHealth[]
  let policies: PolicyRule[]
  const token = await getServerToken()
  const isAdmin = (await getMe(token)).role === 'admin'

  try {
    const [cr, pr] = await Promise.all([
      apiFetch('/api/connectors', token),
      apiFetch('/api/policies',   token),
    ])
    if (!cr.ok || !pr.ok) throw new Error('Failed')
    connectors = await cr.json()
    policies   = await pr.json()
  } catch (e: any) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-[22px] font-semibold tracking-[-0.015em]" style={{ color: 'var(--apple-text-primary)' }}>
          Connections
        </h1>
        <div
          className="rounded-[10px] p-5 flex items-start gap-3"
          style={{ background: 'var(--tint-red)', border: '1px solid #F6D5D2' }}
        >
          <AlertTriangle size={18} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--apple-red)' }} />
          <div>
            <div className="text-[14px] font-semibold" style={{ color: 'var(--apple-red)' }}>Unavailable</div>
            <div className="text-[13px] mt-1" style={{ color: 'var(--apple-text-secondary)' }}>
              {e?.message ?? 'Failed to load settings'}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Optional section: if it cannot load, say so instead of hiding it.
  const aiRes = await apiFetch('/api/ai-model', token).catch(() => null)
  const aiModel: AiModelSettings | null = aiRes?.ok ? await aiRes.json() : null
  const evRes = aiModel?.configured ? await apiFetch('/api/ai-model/evaluations/latest', token).catch(() => null) : null
  const aiEvaluation: AiModelEvaluationState | null = evRes?.ok ? await evRes.json() : null

  const slaPolicy      = policies.find(p => p.rule_type === 'sla')
  const territoryRules = policies.filter(p => p.rule_type === 'territory')
  const connectedCount = connectors.filter(c => c.status === 'connected').length
  const webhookUrl     = `${(process.env.PUBLIC_API_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/webhooks/hubspot`

  return (
    <div className="flex flex-col gap-7 max-w-2xl">

      {/* ── Page header ─────────────────────────────────────────── */}
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.015em]" style={{ color: 'var(--apple-text-primary)' }}>
          Connections
        </h1>
        <p className="text-[13px] mt-1" style={{ color: 'var(--apple-text-tertiary)' }}>
          {connectedCount} of {connectors.length} tools connected
        </p>
      </div>

      <section aria-labelledby="connections-heading" className="space-y-3">
        <h2 id="connections-heading" className="label-caps px-0.5">Tools</h2>
        {connectors.map(c => <ConnectionCard key={c.name} connector={c} canEdit={isAdmin} webhookUrl={webhookUrl} />)}
      </section>

      <section aria-labelledby="ai-heading" className="space-y-3">
        <h2 id="ai-heading" className="label-caps px-0.5">AI</h2>
        {aiModel ? <AiModelCard settings={aiModel} evaluation={aiEvaluation} canEdit={isAdmin} /> : (
          <div role="alert" className="apple-card p-5 text-[13px]" style={{ color: 'var(--apple-red)' }}>
            AI model settings could not be loaded. Leads are still decided by the rules.
          </div>
        )}
      </section>

      <section aria-labelledby="sla-heading" className="space-y-3">
        <h2 id="sla-heading" className="label-caps px-0.5">Response time</h2>
        <div className="apple-card p-5 space-y-4">
          <div>
            <div className="text-[14px] font-semibold" style={{ color: 'var(--apple-text-primary)' }}>
              {slaPolicy?.name ?? 'First response time'}
            </div>
            <p className="text-[13px] mt-1" style={{ color: 'var(--apple-text-secondary)' }}>
              Measured from the moment the form is submitted. Leads not contacted in time are flagged for follow-up.
            </p>
          </div>
          {slaPolicy ? (
            <SlaForm ruleId={slaPolicy.id} initialMinutes={slaPolicy.sla_minutes || 15} canEdit={isAdmin} />
          ) : (
            <p className="text-[13px]" style={{ color: 'var(--apple-red)' }}>
              This workspace has no response-time policy, so deadlines cannot be tracked.
            </p>
          )}
        </div>
      </section>

      <section aria-labelledby="routing-heading" className="space-y-3">
        <h2 id="routing-heading" className="label-caps px-0.5">Routing</h2>
        <div className="apple-card p-5 flex items-center justify-between gap-4">
          <p className="text-[13px]" style={{ color: 'var(--apple-text-secondary)' }}>
            {territoryRules.length === 0
              ? 'No territories are set up, so new leads wait for someone to assign them.'
              : `${territoryRules.length} ${territoryRules.length === 1 ? 'territory' : 'territories'} decide which reps receive new leads.`}
          </p>
          <Link href="/reps" className="text-[13px] font-medium whitespace-nowrap hover:underline" style={{ color: 'var(--apple-blue)' }}>
            Manage reps and territories
          </Link>
        </div>
      </section>
    </div>
  )
}
