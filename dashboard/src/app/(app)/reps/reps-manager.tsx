'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { ChipInput, fieldClass } from '@/components/chip-input'

export type Rep = { id: string; name: string; email: string; title: string | null; available: boolean; activeInSalesforce: boolean }
export type Territory = { id: string; name: string; countries: string[] | null; repIds: string[] | null; missingReps: number; priority: number }
type Settings = { version: number; maxOpenLeadsPerRep: number } | null
type Message = { kind: 'ok' | 'error'; text: string } | null

async function call(method: string, path: string, body?: unknown): Promise<{ ok: boolean; data: any }> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}))
  return { ok: res.ok, data }
}
const errorText = (data: any) => [data.message ?? 'Something went wrong. Please try again.', data.fix].filter(Boolean).join(' ')

function Notice({ message }: { message: Message }) {
  if (!message) return null
  return (
    <p role={message.kind === 'error' ? 'alert' : 'status'} className="text-[13px]"
      style={{ color: message.kind === 'error' ? 'var(--apple-red)' : 'var(--apple-green)' }}>{message.text}</p>
  )
}

export function RepsManager({ reps, territories, settings, isAdmin }: { reps: Rep[]; territories: Territory[]; settings: Settings; isAdmin: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message>(null)

  async function run(fn: () => Promise<{ ok: boolean; data: any }>, success: (data: any) => string) {
    setBusy(true)
    setMessage(null)
    const { ok, data } = await fn()
    setBusy(false)
    setMessage(ok ? { kind: 'ok', text: success(data) } : { kind: 'error', text: errorText(data) })
    if (ok) router.refresh()
    return ok
  }

  return (
    <div className="space-y-6">
      <section className="apple-card overflow-hidden" aria-labelledby="reps-heading">
        <div className="p-5 flex items-start justify-between gap-4">
          <div>
            <h2 id="reps-heading" className="text-[14px] font-semibold">Reps</h2>
            <p className="text-[12px]" style={{ color: 'var(--apple-text-secondary)' }}>
              Imported from Salesforce. Turn someone off while they are on holiday and they will get no new leads.
            </p>
          </div>
          {isAdmin && (
            <Button type="button" disabled={busy}
              onClick={() => void run(() => call('POST', '/api/reps/import'),
                d => `Imported from Salesforce: ${d.added} new, ${d.updated} updated${d.deactivated ? `, ${d.deactivated} no longer active` : ''}.`)}>
              {busy ? 'Working…' : 'Import from Salesforce'}
            </Button>
          )}
        </div>
        <div className="px-5 pb-3"><Notice message={message} /></div>
        {reps.length === 0 ? (
          <p className="px-5 pb-5 text-[13px] text-[color:var(--apple-text-secondary)]">
            No reps yet. {isAdmin ? 'Connect Salesforce on the Settings page, then import your reps.' : 'Ask an admin to import reps from Salesforce.'}
          </p>
        ) : (
          <table className="w-full text-[13px]">
            <caption className="sr-only">Sales reps</caption>
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide" style={{ color: 'var(--apple-text-tertiary)' }}>
                <th scope="col" className="px-5 py-3 font-medium">Name</th>
                <th scope="col" className="px-5 py-3 font-medium">Email</th>
                <th scope="col" className="px-5 py-3 font-medium">Taking new leads</th>
              </tr>
            </thead>
            <tbody>
              {reps.map(r => (
                <tr key={r.id} className="border-t" style={{ borderColor: 'var(--apple-separator)' }}>
                  <td className="px-5 py-3">
                    {r.name}
                    {r.title && <span className="ml-2 text-[11px] text-[color:var(--apple-text-tertiary)]">{r.title}</span>}
                    {!r.activeInSalesforce && <span className="ml-2 text-[11px]" style={{ color: 'var(--apple-red)' }}>No longer active in Salesforce</span>}
                  </td>
                  <td className="px-5 py-3">{r.email}</td>
                  <td className="px-5 py-3">
                    <label className="inline-flex items-center gap-2">
                      <input type="checkbox" className="w-4 h-4" checked={r.available} disabled={!isAdmin || busy || !r.activeInSalesforce}
                        aria-label={`${r.name} is taking new leads`}
                        onChange={e => {
                          const available = e.target.checked
                          void run(() => call('PATCH', `/api/reps/${r.id}`, { available }),
                            () => available ? `${r.name} will receive new leads.` : `${r.name} will not receive new leads until turned back on.`)
                        }} />
                      <span>{r.available && r.activeInSalesforce ? 'Yes' : 'No'}</span>
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <CapacityCard settings={settings} isAdmin={isAdmin} />
      <TerritoriesCard territories={territories} reps={reps} isAdmin={isAdmin} />
    </div>
  )
}

function CapacityCard({ settings, isAdmin }: { settings: Settings; isAdmin: boolean }) {
  const router = useRouter()
  const [value, setValue] = useState(settings?.maxOpenLeadsPerRep ?? NaN)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message>(null)
  if (!settings) {
    return <p role="alert" className="text-[13px]" style={{ color: 'var(--apple-red)' }}>Lead assignment settings are missing for this workspace, so leads cannot be routed. Ask an admin to run the latest database update.</p>
  }
  return (
    <section className="apple-card p-5 space-y-3" aria-labelledby="cap-heading">
      <h2 id="cap-heading" className="text-[14px] font-semibold">How many leads per rep</h2>
      <form className="flex items-end gap-3" onSubmit={async e => {
        e.preventDefault()
        setBusy(true)
        setMessage(null)
        const { ok, data } = await call('PUT', '/api/reps/settings', { maxOpenLeadsPerRep: value, version: settings.version })
        setBusy(false)
        setMessage(ok ? { kind: 'ok', text: 'Saved.' } : { kind: 'error', text: errorText(data) })
        if (ok) router.refresh()
      }}>
        <div>
          <label htmlFor="max-open" className="text-[12px] font-medium block mb-1">Most open leads a rep can have</label>
          <input id="max-open" type="number" min={1} max={10000} step={1} required disabled={!isAdmin}
            value={Number.isFinite(value) ? value : ''} onChange={e => setValue(e.target.value === '' ? NaN : Number(e.target.value))}
            className={`${fieldClass} w-36`} aria-describedby="max-open-hint" />
        </div>
        {isAdmin && <Button type="submit" disabled={busy || value === settings.maxOpenLeadsPerRep || !Number.isFinite(value)}>{busy ? 'Saving…' : 'Save'}</Button>}
      </form>
      <p id="max-open-hint" className="text-[12px]" style={{ color: 'var(--apple-text-secondary)' }}>
        Reps at this number are skipped. If every rep in a territory is full or away, the lead waits for a person to assign it.
      </p>
      <Notice message={message} />
    </section>
  )
}

type Draft = { id: string | null; name: string; everywhere: boolean; countries: string[]; allReps: boolean; repIds: string[] }
const emptyDraft: Draft = { id: null, name: '', everywhere: false, countries: [], allReps: true, repIds: [] }

function TerritoriesCard({ territories, reps, isAdmin }: { territories: Territory[]; reps: Rep[]; isAdmin: boolean }) {
  const router = useRouter()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message>(null)
  const repName = (id: string) => reps.find(r => r.id === id)?.name ?? 'Unknown rep'

  async function save(d: Draft) {
    setBusy(true)
    setMessage(null)
    const body = { name: d.name, countries: d.everywhere ? null : d.countries, repIds: d.allReps ? null : d.repIds }
    const { ok, data } = d.id ? await call('PUT', `/api/territories/${d.id}`, body) : await call('POST', '/api/territories', body)
    setBusy(false)
    if (!ok) { setMessage({ kind: 'error', text: errorText(data) }); return }
    setMessage({ kind: 'ok', text: `Territory "${d.name}" saved.` })
    setDraft(null)
    router.refresh()
  }

  async function remove(t: Territory) {
    if (!confirm(`Remove the territory "${t.name}"? Leads from these countries will use your other territories.`)) return
    setBusy(true)
    const { ok, data } = await call('DELETE', `/api/territories/${t.id}`)
    setBusy(false)
    setMessage(ok ? { kind: 'ok', text: `Territory "${t.name}" removed.` } : { kind: 'error', text: errorText(data) })
    if (ok) router.refresh()
  }

  return (
    <section className="apple-card p-5 space-y-4" aria-labelledby="terr-heading">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="terr-heading" className="text-[14px] font-semibold">Territories</h2>
          <p className="text-[12px]" style={{ color: 'var(--apple-text-secondary)' }}>
            Checked from top to bottom; the first territory that matches the lead&apos;s country wins. Leads that match none wait for a person to assign them.
          </p>
        </div>
        {isAdmin && !draft && <Button type="button" variant="outline" onClick={() => setDraft(emptyDraft)}>Add territory</Button>}
      </div>

      {territories.length === 0 && !draft && <p className="text-[13px] text-[color:var(--apple-text-secondary)]">No territories yet, so no leads will be assigned automatically.</p>}

      <ul className="space-y-2" aria-label="Territories">
        {territories.map(t => (
          <li key={t.id} className="border rounded-[10px] p-3 flex items-start justify-between gap-4" style={{ borderColor: 'var(--apple-separator)' }}>
            <div className="text-[13px]">
              <p className="font-medium">{t.name}</p>
              <p className="text-[color:var(--apple-text-secondary)]">From: {t.countries === null ? 'Everywhere' : t.countries.join(', ')}</p>
              <p className="text-[color:var(--apple-text-secondary)]">Goes to: {t.repIds === null ? 'All reps' : t.repIds.map(repName).join(', ') || 'Nobody'}</p>
              {t.missingReps > 0 && <p style={{ color: 'var(--apple-red)' }}>{t.missingReps} rep(s) here are no longer imported. Edit to fix.</p>}
            </div>
            {isAdmin && (
              <div className="flex gap-1 text-[12px]">
                <button type="button" className="h-7 px-2 rounded-[6px] font-medium hover:bg-[#F1F1EF] disabled:opacity-50" style={{ color: 'var(--apple-text-secondary)' }} disabled={busy}
                  onClick={() => setDraft({ id: t.id, name: t.name, everywhere: t.countries === null, countries: t.countries ?? [], allReps: t.repIds === null, repIds: t.repIds ?? [] })}>
                  Edit<span className="sr-only"> {t.name}</span>
                </button>
                <button type="button" className="h-7 px-2 rounded-[6px] font-medium hover:bg-[color:var(--tint-red)] disabled:opacity-50" style={{ color: 'var(--apple-red)' }} disabled={busy} onClick={() => void remove(t)}>
                  Remove<span className="sr-only"> {t.name}</span>
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {draft && (
        <form className="border rounded-[10px] p-4 space-y-4" style={{ borderColor: 'var(--apple-separator)' }}
          aria-label={draft.id ? 'Edit territory' : 'New territory'}
          onSubmit={e => { e.preventDefault(); void save(draft) }}>
          <div>
            <label htmlFor="terr-name" className="text-[12px] font-medium block mb-1">Name</label>
            <input id="terr-name" required maxLength={100} value={draft.name} placeholder="North America"
              onChange={e => setDraft({ ...draft, name: e.target.value })} className={`${fieldClass} w-72`} />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-[12px] font-medium">Leads from</legend>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="radio" name="terr-where" checked={draft.everywhere} onChange={() => setDraft({ ...draft, everywhere: true })} /> Everywhere
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="radio" name="terr-where" checked={!draft.everywhere} onChange={() => setDraft({ ...draft, everywhere: false })} /> These countries
            </label>
            {!draft.everywhere && (
              <ChipInput id="terr-countries" label="Countries" upper disabled={false} hint="Two-letter country codes, e.g. US, CA."
                values={draft.countries} onChange={v => setDraft({ ...draft, countries: v })} />
            )}
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-[12px] font-medium">Go to</legend>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="radio" name="terr-who" checked={draft.allReps} onChange={() => setDraft({ ...draft, allReps: true })} /> All reps
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="radio" name="terr-who" checked={!draft.allReps} onChange={() => setDraft({ ...draft, allReps: false })} /> Only these reps
            </label>
            {!draft.allReps && (
              reps.length === 0
                ? <p className="text-[12px] text-[color:var(--apple-text-secondary)]">Import reps first.</p>
                : <div className="grid grid-cols-2 gap-1 pl-6">
                    {reps.map(r => (
                      <label key={r.id} className="flex items-center gap-2 text-[13px]">
                        <input type="checkbox" checked={draft.repIds.includes(r.id)}
                          onChange={e => setDraft({ ...draft, repIds: e.target.checked ? [...draft.repIds, r.id] : draft.repIds.filter(x => x !== r.id) })} />
                        {r.name}
                      </label>
                    ))}
                  </div>
            )}
          </fieldset>
          <div className="flex gap-3">
            <Button type="submit" disabled={busy || !draft.name.trim()}>{busy ? 'Saving…' : 'Save territory'}</Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        </form>
      )}
      <Notice message={message} />
    </section>
  )
}
