import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Check } from 'lucide-react'
import { getServerToken } from '@/lib/auth'
import { apiFetch, getMe } from '@/lib/api'
import type { SetupStatus, SetupStep, SetupStepKey, TestLeadSummary } from '@/types/api'
import { skipSetup } from './actions'
import { TestLeadPanel } from './test-lead-panel'
import { FinishButton } from './finish-button'

export const dynamic = 'force-dynamic'

type StepCopy = { title: string; why: string; href?: string; cta?: string; status: (s: SetupStep) => string }

const CONNECTION_STATUS: Record<string, string> = {
  connected:       'Connected',
  needs_attention: 'Needs attention: the last check failed',
  not_connected:   'Not connected',
}
const connection = (s: SetupStep) => CONNECTION_STATUS[String(s.facts.status)] ?? 'Not connected'

const STEPS: Record<SetupStepKey, StepCopy> = {
  hubspot: {
    title: 'Connect HubSpot', why: 'Your form submissions come from HubSpot.',
    href: '/settings', cta: 'Open Connections', status: connection,
  },
  salesforce: {
    title: 'Connect Salesforce', why: 'Each lead is assigned to a rep in Salesforce and given a call Task.',
    href: '/settings', cta: 'Open Connections', status: connection,
  },
  apollo: {
    title: 'Connect Apollo', why: 'Looks up company details and adds leads to sequences. Without it, leads are scored on form details only.',
    href: '/settings', cta: 'Open Connections', status: connection,
  },
  reps: {
    title: 'Import your reps', why: 'Bring in your Salesforce users and mark who is taking new leads.',
    href: '/reps', cta: 'Open Reps & territories',
    status: s => Number(s.facts.reps) === 0
      ? 'No reps imported yet'
      : `${s.facts.takingLeads} of ${s.facts.reps} ${Number(s.facts.reps) === 1 ? 'rep is' : 'reps are'} taking leads`,
  },
  ideal_customer: {
    title: 'Review your ideal customer', why: 'Decide which companies are a Great fit, a Good fit or Not a fit.',
    href: '/ideal-customer', cta: 'Open Ideal customer',
    status: s => (s.done ? 'Saved' : 'Using the starting settings'),
  },
  outreach: {
    title: 'Choose outreach', why: 'Pick an Apollo sequence, or follow-up by hand, for each fit level. Until then, qualified leads are flagged for attention.',
    href: '/outreach', cta: 'Open Outreach',
    status: s => (s.facts.valid === false ? 'Needs to be set up' : `${s.facts.tiersChosen} of ${s.facts.tiers} fit levels set`),
  },
  test_lead: {
    title: 'Send a test lead', why: 'Watch one lead go through every step before real ones arrive.',
    status: s => (Number(s.facts.sent) > 0 ? `${s.facts.sent} sent` : 'Not sent yet'),
  },
}

function StepRow({ step, index, children }: { step: SetupStep; index: number; children?: React.ReactNode }) {
  const copy = STEPS[step.key]
  return (
    <li className="apple-card p-5" aria-labelledby={`step-${step.key}`}>
      <div className="flex items-start gap-3.5">
        <span className="w-6 h-6 rounded-full flex items-center justify-center text-[12px] font-semibold flex-shrink-0"
          style={step.done
            ? { background: 'var(--apple-green)', color: '#FFFFFF' }
            : { background: 'var(--apple-gray6)', color: 'var(--apple-text-secondary)', boxShadow: 'inset 0 0 0 1px var(--apple-separator)' }}
          aria-hidden="true">
          {step.done ? <Check size={13} strokeWidth={3} /> : index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 id={`step-${step.key}`} className="text-[14px] font-semibold">
              {copy.title}
              {!step.required && <span className="ml-2 text-[11px] font-medium" style={{ color: 'var(--apple-text-tertiary)' }}>Recommended</span>}
            </h2>
            <span className="text-[12px] font-medium" style={{ color: step.done ? 'var(--apple-green)' : 'var(--apple-text-secondary)' }}>
              <span className="sr-only">{step.done ? 'Done: ' : 'Not done: '}</span>{copy.status(step)}
            </span>
          </div>
          <p className="text-[13px] mt-1" style={{ color: 'var(--apple-text-secondary)' }}>{copy.why}</p>
          {copy.href && (
            <Link href={copy.href}
              className="inline-flex items-center h-8 px-3 mt-3 rounded-[7px] border bg-white text-[12px] font-medium hover:bg-[color:var(--surface-subtle)]"
              style={{ borderColor: 'var(--border-strong)' }}>
              {copy.cta}
            </Link>
          )}
          {children}
        </div>
      </div>
    </li>
  )
}

export default async function SetupPage() {
  const token = await getServerToken()
  const me = await getMe(token)
  if (!me.workspace) redirect('/welcome')
  if (me.role !== 'admin') redirect('/dashboard')

  let status: SetupStatus | null = null
  let testLeads: TestLeadSummary[] = []
  try {
    const [sr, tr] = await Promise.all([apiFetch('/api/setup', token), apiFetch('/api/test-lead', token)])
    if (sr.ok) status = await sr.json() as SetupStatus
    if (tr.ok) testLeads = (await tr.json() as { leads: TestLeadSummary[] }).leads
  } catch { /* shown below */ }

  const required = status?.steps.filter(s => s.required) ?? []
  const requiredDone = required.filter(s => s.done).length
  const missing = required.filter(s => !s.done).map(s => STEPS[s.key].title)

  return (
    <main className="min-h-screen px-6 py-12" style={{ background: 'var(--apple-bg-desktop)' }}>
      <div className="w-full max-w-[720px] mx-auto space-y-6">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.015em]">Set up {me.workspace.name}</h1>
          <p className="text-[13px] mt-1 leading-relaxed" style={{ color: 'var(--apple-text-secondary)' }}>
            {status?.completedAt
              ? 'Setup is finished. You can come back here any time to send another test lead.'
              : 'A few steps and new leads will be scored, assigned and followed up automatically. Each step opens the page where you set it up; come back here when you are done.'}
          </p>
          {status && !status.completedAt && (
            <p className="text-[12px] mt-2 font-medium" role="status">{requiredDone} of {required.length} required steps done</p>
          )}
        </div>

        {!status ? (
          <div role="alert" className="apple-card p-5">
            <div className="text-[14px] font-semibold">Setup could not be loaded</div>
            <div className="text-[13px] mt-1" style={{ color: 'var(--apple-text-secondary)' }}>
              The API did not respond. Check that the API service is running, then refresh.
            </div>
          </div>
        ) : (
          <ol className="space-y-3" aria-label="Setup steps">
            {status.steps.map((step, i) => (
              <StepRow key={step.key} step={step} index={i}>
                {step.key === 'test_lead' && <TestLeadPanel defaultEmail={me.user.email ?? ''} initialLeads={testLeads} />}
              </StepRow>
            ))}
          </ol>
        )}

        <div className="flex flex-wrap items-center gap-3">
          {status?.completedAt ? (
            <Link href="/dashboard" className="inline-flex items-center h-9 px-3.5 rounded-[7px] text-[13px] font-medium text-white" style={{ background: 'var(--ink)' }}>
              Go to Overview
            </Link>
          ) : (
            <>
              <FinishButton canFinish={status?.canFinish ?? false} missing={missing} />
              <form action={skipSetup}>
                <button type="submit" className="h-9 px-3 text-[13px] font-medium underline underline-offset-2" style={{ color: 'var(--apple-text-secondary)' }}>
                  Skip for now
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </main>
  )
}
