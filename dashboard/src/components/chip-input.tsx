'use client'

import { useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'

export const fieldClass = 'h-9 px-3 rounded-[7px] text-[13px] border border-[color:var(--border-strong)] bg-white shadow-[0_1px_1px_rgba(0,0,0,0.03)] outline-none focus:border-[color:var(--apple-blue)] focus:ring-[3px] focus:ring-[#2B59C3]/15 disabled:bg-[#FAFAF9] disabled:text-[color:var(--apple-text-secondary)]'
const field = fieldClass

/** Editable list of short values shown as removable chips. Enter or comma-separated paste adds. */
export function ChipInput({ id, label, hint, values, onChange, disabled, upper }: {
  id: string; label: string; hint: string; values: string[]; onChange: (v: string[]) => void; disabled: boolean; upper?: boolean
}) {
  const [draft, setDraft] = useState('')
  function add() {
    const items = draft.split(',').map(s => (upper ? s.trim().toUpperCase() : s.trim().toLowerCase())).filter(Boolean)
    if (items.length) onChange([...new Set([...values, ...items])])
    setDraft('')
  }
  return (
    <div>
      <label htmlFor={id} className="text-[13px] font-medium block">{label}</label>
      <p id={`${id}-hint`} className="text-[12px] mb-2" style={{ color: 'var(--apple-text-secondary)' }}>{hint}</p>
      <ul className="flex flex-wrap gap-1.5 mb-2" aria-label={label}>
        {values.length === 0 && <li className="text-[12px] text-[color:var(--apple-text-tertiary)]">None added</li>}
        {values.map(v => (
          <li key={v} className="inline-flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-[5px] text-[12px] bg-[#F4F4F3] text-[color:var(--apple-text-primary)] border border-[color:var(--apple-separator)]">
            {v}
            {!disabled && (
              <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter(x => x !== v))}
                className="w-5 h-5 inline-flex items-center justify-center rounded-[4px] text-[color:var(--apple-text-tertiary)] hover:bg-[#E7E5E4] hover:text-[color:var(--apple-text-primary)]"><X className="w-3 h-3" aria-hidden="true" /></button>
            )}
          </li>
        ))}
      </ul>
      {!disabled && (
        <div className="flex gap-2">
          <input id={id} aria-describedby={`${id}-hint`} value={draft} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
            placeholder="Type and press Enter" className={`${field} flex-1`} />
          <Button type="button" variant="outline" onClick={add} disabled={!draft.trim()}>Add</Button>
        </div>
      )}
    </div>
  )
}
