'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

export function FinishButton({ canFinish, missing }: { canFinish: boolean; missing: string[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function finish() {
    setBusy(true)
    setError(null)
    const res = await fetch('/api/setup/complete', { method: 'POST' }).catch(() => null)
    const data = await res?.json().catch(() => ({}))
    setBusy(false)
    if (!res?.ok) {
      setError(data?.message ?? 'Setup could not be finished. Please try again.')
      router.refresh()
      return
    }
    router.push('/dashboard')
    router.refresh()
  }

  return (
    <div className="flex items-center gap-3">
      <Button type="button" onClick={finish} disabled={!canFinish || busy} aria-describedby="finish-hint">
        {busy ? 'Finishing…' : 'Finish setup'}
      </Button>
      <span id="finish-hint" role={error ? 'alert' : undefined} className="text-[12px]"
        style={{ color: error ? 'var(--apple-red)' : 'var(--apple-text-tertiary)' }}>
        {error ?? (canFinish ? '' : `Still to do: ${missing.join(', ')}`)}
      </span>
    </div>
  )
}
