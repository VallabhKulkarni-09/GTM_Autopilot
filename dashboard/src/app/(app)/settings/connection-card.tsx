'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff, Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ConnectorHealth } from '@/types/api'

type Field = { key: string; label: string; help?: string; secret?: boolean; placeholder?: string; type?: 'text' | 'checkbox' }

type CardDef = {
  label: string
  purpose: string
  steps: string[]
  fields: Field[]
}

const CARDS: Record<ConnectorHealth['name'], CardDef> = {
  hubspot: {
    label: 'HubSpot',
    purpose: 'Tells GTM Autopilot the moment someone fills in a form.',
    steps: [
      'In HubSpot, go to Settings › Integrations › Private Apps › Create a private app.',
      'On the Scopes tab, tick crm.objects.contacts.read.',
      'Create the app, then copy the Access token and paste it below.',
      'On the app\'s Auth tab, copy the Client secret and paste it below.',
      'After saving, add the webhook address shown here under the app\'s Webhooks tab, subscribed to "Contact › Created".',
    ],
    fields: [
      { key: 'apiKey', label: 'Private app access token', secret: true, placeholder: 'pat-…' },
      { key: 'webhookSecret', label: 'App client secret', secret: true, help: 'Used to check that webhooks really come from HubSpot.' },
    ],
  },
  salesforce: {
    label: 'Salesforce',
    purpose: 'Creates the lead, assigns the rep, adds a follow-up task, and spots booked meetings.',
    steps: [
      'In Salesforce Setup, open App Manager › New Connected App.',
      'Enable OAuth settings, add the "api" scope, and tick "Enable Client Credentials Flow".',
      'After saving, choose Manage › Edit Policies and pick a "Run As" user who can create Leads and Tasks.',
      'Open "Manage Consumer Details" and copy the Consumer key and Consumer secret below.',
    ],
    fields: [
      { key: 'instanceUrl', label: 'Salesforce URL', placeholder: 'https://yourcompany.my.salesforce.com', help: 'The address you see when signed in to Salesforce.' },
      { key: 'clientId', label: 'Consumer key', secret: true },
      { key: 'clientSecret', label: 'Consumer secret', secret: true },
      { key: 'sandbox', label: 'This is a sandbox (test) org', type: 'checkbox' },
    ],
  },
  apollo: {
    label: 'Apollo',
    purpose: 'Looks up company details (size, industry, country) and sends your email sequences.',
    steps: [
      'In Apollo, go to Settings › Integrations › API.',
      'Create a new key. Choose "Master key" (or include Organization enrichment and Sequences).',
      'Copy the key and paste it below.',
    ],
    fields: [{ key: 'apiKey', label: 'API key', secret: true }],
  },
}

type Result = { ok: true; text: string } | { ok: false; text: string; fix?: string }

function StatusPill({ status }: { status: ConnectorHealth['status'] }) {
  const map = {
    connected:       { text: 'Connected',       color: 'var(--apple-green)' },
    needs_attention: { text: 'Needs attention', color: 'var(--apple-orange)' },
    not_connected:   { text: 'Not connected',   color: 'var(--apple-gray2)' },
  }[status]
  return (
    <span className="inline-flex items-center gap-1.5 h-6 px-2 rounded-[5px] border text-[12px] font-medium bg-white whitespace-nowrap flex-shrink-0"
      style={{ borderColor: 'var(--apple-separator)', color: 'var(--apple-text-secondary)' }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: map.color }} aria-hidden="true" />
      {map.text}
    </span>
  )
}

export function ConnectionCard({ connector, canEdit, webhookUrl }: { connector: ConnectorHealth; canEdit: boolean; webhookUrl: string }) {
  const def = CARDS[connector.name]
  const router = useRouter()
  const isConnected = connector.status !== 'not_connected'
  const [open, setOpen] = useState(!isConnected && canEdit)
  const [values, setValues] = useState<Record<string, string | boolean>>(
    connector.name === 'salesforce'
      ? { instanceUrl: String(connector.details.instanceUrl ?? ''), sandbox: Boolean(connector.details.sandbox) }
      : {},
  )
  const [reveal, setReveal] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [copied, setCopied] = useState(false)

  async function submit(kind: 'test' | 'save') {
    setBusy(kind)
    setResult(null)
    try {
      const res = await fetch(`/api/connectors/${connector.name}/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.ok) {
        setResult({ ok: true, text: kind === 'save' ? `${def.label} is connected.` : 'Connection works. Click Save to keep it.' })
        if (kind === 'save') {
          setValues(v => Object.fromEntries(Object.entries(v).filter(([k]) => !def.fields.find(f => f.key === k)?.secret)))
          router.refresh()
        }
      } else {
        setResult({ ok: false, text: data.message ?? 'Could not connect.', fix: data.fix })
      }
    } catch {
      setResult({ ok: false, text: 'Could not reach the server. Check your connection and try again.' })
    } finally {
      setBusy(null)
    }
  }

  const portalId = connector.name === 'hubspot' ? (connector.details.portal_id as string | undefined) : undefined
  const id = (k: string) => `${connector.name}-${k}`

  return (
    <section className="apple-card p-5 space-y-4" aria-labelledby={id('title')}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 id={id('title')} className="text-[14px] font-semibold">{def.label}</h3>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--apple-text-secondary)' }}>{def.purpose}</p>
          {portalId && <p className="text-[12px] mt-1" style={{ color: 'var(--apple-text-tertiary)' }}>HubSpot account {portalId}</p>}
        </div>
        <StatusPill status={connector.status} />
      </div>

      {connector.name === 'hubspot' && isConnected && (
        <div className="rounded-[8px] p-3 text-[13px] space-y-1.5 border" style={{ background: 'var(--surface-subtle)', borderColor: 'var(--apple-separator)' }}>
          <div className="font-medium">Webhook address for HubSpot</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate text-[12px] font-mono px-2 py-1.5 rounded-[6px] bg-white border border-[color:var(--apple-separator)]">{webhookUrl}</code>
            <button type="button" className="inline-flex items-center gap-1 text-[12px] font-medium" style={{ color: 'var(--apple-blue)' }}
              onClick={() => { void navigator.clipboard.writeText(webhookUrl); setCopied(true); setTimeout(() => setCopied(false), 2000) }}>
              {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="text-[12px]" style={{ color: 'var(--apple-text-secondary)' }}>
            Paste it in your HubSpot private app › Webhooks › Target URL, and subscribe to Contact › Created.
          </p>
        </div>
      )}

      {canEdit ? (
        <button type="button" aria-expanded={open} aria-controls={id('form')} onClick={() => setOpen(o => !o)}
          className="text-[13px] font-medium" style={{ color: 'var(--apple-blue)' }}>
          {open ? 'Hide setup' : isConnected ? 'Update details' : 'Set up'}
          <span className="sr-only"> for {def.label}</span>
        </button>
      ) : (
        !isConnected && <p className="text-[12px]" style={{ color: 'var(--apple-text-tertiary)' }}>Ask an admin to connect {def.label}.</p>
      )}

      {open && canEdit && (
        <form id={id('form')} className="space-y-4" onSubmit={e => { e.preventDefault(); void submit('save') }}>
          <ol className="list-decimal pl-5 space-y-1 text-[13px]" style={{ color: 'var(--apple-text-secondary)' }}>
            {def.steps.map(s => <li key={s}>{s}</li>)}
          </ol>

          {def.fields.map(f => f.type === 'checkbox' ? (
            <label key={f.key} className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={Boolean(values[f.key])} onChange={e => setValues(v => ({ ...v, [f.key]: e.target.checked }))} />
              {f.label}
            </label>
          ) : (
            <div key={f.key} className="space-y-1">
              <label htmlFor={id(f.key)} className="text-[13px] font-medium block">{f.label}</label>
              <div className="relative">
                <input id={id(f.key)} autoComplete="off" spellCheck={false}
                  type={f.secret && !reveal[f.key] ? 'password' : 'text'}
                  value={String(values[f.key] ?? '')}
                  onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
                  placeholder={f.secret && isConnected ? 'Saved. Leave blank to keep the current value.' : f.placeholder}
                  aria-describedby={f.help ? id(`${f.key}-help`) : undefined}
                  className="w-full h-9 px-3 pr-10 rounded-[7px] text-[13px] border border-[color:var(--border-strong)] bg-white outline-none focus:border-[color:var(--apple-blue)] focus:ring-[3px] focus:ring-[#2B59C3]/15" />
                {f.secret && (
                  <button type="button" onClick={() => setReveal(r => ({ ...r, [f.key]: !r[f.key] }))}
                    aria-label={reveal[f.key] ? `Hide ${f.label}` : `Show ${f.label}`}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1" style={{ color: 'var(--apple-text-tertiary)' }}>
                    {reveal[f.key] ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                )}
              </div>
              {f.help && <p id={id(`${f.key}-help`)} className="text-[12px]" style={{ color: 'var(--apple-text-tertiary)' }}>{f.help}</p>}
            </div>
          ))}

          <div className="flex gap-2">
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void submit('test')}>
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </Button>
            <Button type="submit" disabled={busy !== null}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
          </div>
        </form>
      )}

      {result && (
        <div role={result.ok ? 'status' : 'alert'} className="rounded-[8px] p-3 text-[13px] border"
          style={{ background: result.ok ? 'var(--tint-green)' : 'var(--tint-red)', borderColor: result.ok ? '#CFE8D7' : '#F6D5D2' }}>
          <div className="font-medium" style={{ color: result.ok ? 'var(--apple-green)' : 'var(--apple-red)' }}>{result.text}</div>
          {!result.ok && result.fix && <div className="mt-1" style={{ color: 'var(--apple-text-secondary)' }}>How to fix: {result.fix}</div>}
        </div>
      )}
    </section>
  )
}
