'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { ChipInput, fieldClass as field } from '@/components/chip-input'

export type IcpConfig = {
  industries: string[]
  countries: string[]
  employee_floor: number
  employee_near_min: number
  employee_min: number
  employee_max: number
  title_keywords: string[]
  intent_keywords: string[]
  block_free_email: boolean
  weights: Record<'company_size' | 'company_size_near' | 'company_size_large' | 'industry' | 'country' | 'intent' | 'title', number>
  tier_thresholds: { tier_1: number; tier_2: number }
}
export type IcpPolicy = { id: string; version: number; updatedAt: string; config: IcpConfig }

type Preview = { icp_score: number; icp_tier: 'tier_1' | 'tier_2' | 'not_icp'; fit_label: string; reason_codes: string[] }

/** Plain-language versions of the reason codes rules.ts can produce. */
const REASONS: Record<string, string> = {
  DISQUALIFIED_FREE_EMAIL_PROVIDER: 'Uses a personal email address (e.g. Gmail)',
  DISQUALIFIED_TOO_SMALL: 'Company is below the smallest size you accept',
  ICP_COMPANY_SIZE_IN_RANGE: 'Company size is in your ideal range',
  ICP_COMPANY_SIZE_NEAR_RANGE: 'Company is a little smaller than ideal',
  ICP_COMPANY_SIZE_LARGE: 'Company is larger than your ideal range',
  NOT_ICP_TOO_SMALL: 'Company is too small to earn size points',
  ENRICHMENT_MISSING_COMPANY_SIZE: 'Company size unknown',
  ICP_INDUSTRY_SAAS: 'Industry matches',
  NOT_ICP_INDUSTRY_MISMATCH: 'Industry is not on your list',
  ENRICHMENT_MISSING_INDUSTRY: 'Industry unknown',
  ICP_REGION_NA: 'Country matches',
  ICP_REGION_EMEA_APAC: 'Country matches',
  NOT_ICP_REGION_EXCLUDED: 'Country is not on your list',
  ENRICHMENT_MISSING_REGION: 'Country unknown',
  ICP_HIGH_INTENT_FORM: 'Came from a high-intent form',
  ICP_SENIOR_TITLE: 'Job title matches',
  ENRICHMENT_MISSING_ALL_FIELDS: 'No company or form details available',
  NOT_ICP_SCORE_TOO_LOW: 'Score is below the "Good fit" level',
}

const WEIGHT_LABELS: [keyof IcpConfig['weights'], string][] = [
  ['company_size', 'Company size in ideal range'],
  ['company_size_near', 'Company a little smaller than ideal'],
  ['company_size_large', 'Company larger than ideal'],
  ['industry', 'Industry matches'],
  ['country', 'Country matches'],
  ['intent', 'High-intent form'],
  ['title', 'Job title matches'],
]

function NumberField({ id, label, value, onChange, disabled, max }: {
  id: string; label: string; value: number; onChange: (n: number) => void; disabled: boolean; max?: number
}) {
  return (
    <div>
      <label htmlFor={id} className="text-[12px] font-medium block mb-1">{label}</label>
      <input id={id} type="number" min={0} max={max} step={1} value={Number.isFinite(value) ? value : ''} disabled={disabled}
        onChange={e => onChange(e.target.value === '' ? NaN : Number(e.target.value))} className={`${field} w-36`} />
    </div>
  )
}

export function IcpEditor({ policy, isAdmin }: { policy: IcpPolicy; isAdmin: boolean }) {
  const router = useRouter()
  const [config, setConfig] = useState<IcpConfig>(policy.config)
  const [version, setVersion] = useState(policy.version)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string; issues?: string[] } | null>(null)
  const readOnly = !isAdmin
  const dirty = JSON.stringify(config) !== JSON.stringify(policy.config)

  const set = <K extends keyof IcpConfig>(k: K, v: IcpConfig[K]) => setConfig(c => ({ ...c, [k]: v }))

  async function save() {
    setBusy(true)
    setMessage(null)
    const res = await fetch('/api/icp', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config, version }),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) {
      setMessage({ kind: 'error', text: data.message ?? 'Could not save. Please try again.', issues: data.issues })
      return
    }
    setVersion(data.version)
    setConfig(data.config)
    setMessage({ kind: 'ok', text: 'Saved. New leads will be scored with these settings.' })
    router.refresh()
  }

  return (
    <div className="space-y-6">
      <form className="space-y-6" onSubmit={e => { e.preventDefault(); void save() }}>
        <section className="apple-card p-5 space-y-5" aria-labelledby="who-heading">
          <h2 id="who-heading" className="text-[14px] font-semibold">Who you sell to</h2>
          <ChipInput id="icp-industries" label="Industries" disabled={readOnly}
            hint="A lead's industry matches if it contains any of these words, e.g. “software”."
            values={config.industries} onChange={v => set('industries', v)} />
          <ChipInput id="icp-countries" label="Countries" upper disabled={readOnly}
            hint="Two-letter country codes, e.g. US, GB, DE."
            values={config.countries} onChange={v => set('countries', v)} />
          <ChipInput id="icp-titles" label="Job titles" disabled={readOnly}
            hint="Words in the job title that signal a decision maker, e.g. “director”."
            values={config.title_keywords} onChange={v => set('title_keywords', v)} />
          <ChipInput id="icp-intent" label="High-intent forms" disabled={readOnly}
            hint="Words in the form or source name that signal buying intent, e.g. “demo”."
            values={config.intent_keywords} onChange={v => set('intent_keywords', v)} />
        </section>

        <section className="apple-card p-5 space-y-4" aria-labelledby="size-heading">
          <h2 id="size-heading" className="text-[14px] font-semibold">Company size (employees)</h2>
          <div className="flex flex-wrap gap-4">
            <NumberField id="icp-emp-min" label="Ideal from" value={config.employee_min} disabled={readOnly} onChange={n => set('employee_min', n)} />
            <NumberField id="icp-emp-max" label="Ideal up to" value={config.employee_max} disabled={readOnly} onChange={n => set('employee_max', n)} />
            <NumberField id="icp-emp-near" label="Partial fit from" value={config.employee_near_min} disabled={readOnly} onChange={n => set('employee_near_min', n)} />
            <NumberField id="icp-emp-floor" label="Never a fit below" value={config.employee_floor} disabled={readOnly} onChange={n => set('employee_floor', n)} />
          </div>
          <div className="flex items-center gap-2">
            <input id="icp-free-email" type="checkbox" checked={config.block_free_email} disabled={readOnly}
              onChange={e => set('block_free_email', e.target.checked)} className="w-4 h-4" />
            <label htmlFor="icp-free-email" className="text-[13px]">Never a fit if they sign up with a personal email (Gmail, Yahoo, …)</label>
          </div>
        </section>

        <section className="apple-card p-5 space-y-4" aria-labelledby="score-heading">
          <h2 id="score-heading" className="text-[14px] font-semibold">Fit levels</h2>
          <p className="text-[12px]" style={{ color: 'var(--apple-text-secondary)' }}>
            Each lead gets a score from 0 to 100. Great fit and Good fit leads are routed to a rep; Not a fit leads go to nurture.
          </p>
          <div className="flex flex-wrap gap-4">
            <NumberField id="icp-tier1" label="Great fit at score" max={100} value={config.tier_thresholds.tier_1} disabled={readOnly}
              onChange={n => set('tier_thresholds', { ...config.tier_thresholds, tier_1: n })} />
            <NumberField id="icp-tier2" label="Good fit at score" max={100} value={config.tier_thresholds.tier_2} disabled={readOnly}
              onChange={n => set('tier_thresholds', { ...config.tier_thresholds, tier_2: n })} />
          </div>
          <details>
            <summary className="text-[13px] font-medium cursor-pointer">Points per signal</summary>
            <div className="flex flex-wrap gap-4 mt-3">
              {WEIGHT_LABELS.map(([k, label]) => (
                <NumberField key={k} id={`icp-w-${k}`} label={label} max={100} value={config.weights[k]} disabled={readOnly}
                  onChange={n => set('weights', { ...config.weights, [k]: n })} />
              ))}
            </div>
          </details>
        </section>

        {message && (
          <div role={message.kind === 'error' ? 'alert' : 'status'} className="text-[13px]"
            style={{ color: message.kind === 'error' ? 'var(--apple-red)' : 'var(--apple-green)' }}>
            <p>{message.kind === 'error' && message.issues?.length ? 'Please fix the following:' : message.text}</p>
            {message.issues && message.issues.length > 0 && (
              <ul className="list-disc ml-5 mt-1">{message.issues.map(i => <li key={i}>{i}</li>)}</ul>
            )}
          </div>
        )}

        {isAdmin ? (
          <div className="flex gap-3">
            <Button type="submit" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save changes'}</Button>
            {dirty && <Button type="button" variant="outline" disabled={busy} onClick={() => setConfig(policy.config)}>Discard</Button>}
          </div>
        ) : (
          <p className="text-[12px] text-[color:var(--apple-text-tertiary)]">Only admins can change these settings.</p>
        )}
      </form>

      <PreviewCard config={config} />
    </div>
  )
}

function PreviewCard({ config }: { config: IcpConfig }) {
  const [sample, setSample] = useState({ email: '', title: '', source: '', industry: '', employees: '', country: '' })
  const [result, setResult] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const upd = (k: keyof typeof sample) => (e: React.ChangeEvent<HTMLInputElement>) => setSample(s => ({ ...s, [k]: e.target.value }))
  const opt = (s: string) => (s.trim() ? s.trim() : null)

  async function check() {
    setBusy(true)
    setError(null)
    setResult(null)
    const hasCompany = sample.industry || sample.employees || sample.country
    const res = await fetch('/api/icp/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config,
        lead: { email: opt(sample.email), title: opt(sample.title), source: opt(sample.source) },
        company: hasCompany
          ? { industry: opt(sample.industry), country: opt(sample.country), employee_count: sample.employees ? Number(sample.employees) : null }
          : null,
      }),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) { setError(data.issues?.join('; ') ?? data.message ?? 'Could not check this lead.'); return }
    setResult(data)
  }

  const inputs: [keyof typeof sample, string, string, string?][] = [
    ['email', 'Work email', 'jane@acme.com', 'email'],
    ['title', 'Job title', 'VP of Sales'],
    ['source', 'Form name', 'Request a demo'],
    ['industry', 'Industry', 'Software'],
    ['employees', 'Employees', '250', 'number'],
    ['country', 'Country code', 'US'],
  ]
  const color = result?.icp_tier === 'tier_1' ? 'var(--apple-green)' : result?.icp_tier === 'tier_2' ? 'var(--apple-blue)' : 'var(--apple-red)'

  return (
    <section className="apple-card p-5 space-y-4" aria-labelledby="preview-heading">
      <div>
        <h2 id="preview-heading" className="text-[14px] font-semibold">Would this lead qualify?</h2>
        <p className="text-[12px]" style={{ color: 'var(--apple-text-secondary)' }}>
          Try a made-up lead against the settings above, including changes you haven&apos;t saved. Nothing is stored.
        </p>
      </div>
      <form className="space-y-4" onSubmit={e => { e.preventDefault(); void check() }}>
        <div className="grid grid-cols-3 gap-3">
          {inputs.map(([k, label, ph, type]) => (
            <div key={k}>
              <label htmlFor={`pv-${k}`} className="text-[12px] font-medium block mb-1">{label}</label>
              <input id={`pv-${k}`} type={type ?? 'text'} min={type === 'number' ? 0 : undefined} placeholder={ph}
                value={sample[k]} onChange={upd(k)} className={`${field} w-full`} />
            </div>
          ))}
        </div>
        <Button type="submit" disabled={busy}>{busy ? 'Checking…' : 'Check this lead'}</Button>
      </form>
      <div aria-live="polite">
        {error && <p role="alert" className="text-[13px]" style={{ color: 'var(--apple-red)' }}>{error}</p>}
        {result && (
          <div className="space-y-2">
            <p className="text-[14px] font-semibold" style={{ color }}>
              {result.fit_label} <span className="text-[13px] font-normal text-[color:var(--apple-text-secondary)]">· score {result.icp_score} of 100</span>
            </p>
            <ul className="list-disc ml-5 text-[13px]">
              {result.reason_codes.map(c => <li key={c}>{REASONS[c] ?? c}</li>)}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}
