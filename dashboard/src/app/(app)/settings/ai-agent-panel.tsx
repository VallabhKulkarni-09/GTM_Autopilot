'use client'
import { useCallback, useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { fitLabel } from '@/lib/describe-event'
import type { AiModelEvaluationState } from '@/types/api'

const POLL_MS = 3000

const FALLBACK_TEXT: Record<string, string> = {
  MODEL_OUTPUT_INVALID: 'answer in the wrong format',
  MODEL_TIMEOUT: 'too slow',
  MODEL_UNREACHABLE: 'not reachable',
}
const RUN_ERRORS: Record<string, string> = {
  MODEL_UNREACHABLE: 'The model server could not be reached.',
  MODEL_CHANGED_BEFORE_RUN: 'The model was changed while the test was starting. Run it again.',
  RUN_TIMED_OUT: 'The run stopped (the worker may have restarted). Run it again.',
  EVERY_CASE_FAILED: 'Every test lead failed. Check the model with Test connection.',
}

/**
 * "Use AI for qualification": run the test leads (golden set) against the saved model, show how
 * often it agreed, and only then allow switching it on.
 */
export function AiAgentPanel({ initial, canEdit }: { initial: AiModelEvaluationState; canEdit: boolean }) {
  const uid = useId()
  const [state, setState] = useState(initial)
  const [busy, setBusy] = useState<null | 'run' | 'toggle'>(null)
  const [error, setError] = useState<string | null>(null)
  const [showMisses, setShowMisses] = useState(false)

  const run = state.evaluation
  const running = run?.status === 'running'

  const refresh = useCallback(async () => {
    const res = await fetch('/api/ai-model/evaluations/latest').catch(() => null)
    if (res?.ok) setState(await res.json())
  }, [])

  useEffect(() => {
    if (!running) return
    const t = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(t)
  }, [running, refresh])

  async function start() {
    setBusy('run'); setError(null)
    try {
      const res = await fetch('/api/ai-model/evaluations', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) setError(data.message ?? 'Could not start the test leads.')
      await refresh()
    } finally { setBusy(null) }
  }

  async function toggle(on: boolean, agent: 'qualification' | 'routing' = 'qualification') {
    setBusy('toggle'); setError(null)
    try {
      const res = await fetch('/api/ai-model/agents', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [agent]: on }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) setError(data.message ?? 'Could not change the setting.')
      await refresh()
    } finally { setBusy(null) }
  }

  const s = run?.summary
  const pct = (a: number, t: number) => (t ? Math.round((a / t) * 100) : 0)

  return (
    <div role="group" className="rounded-[8px] p-4 space-y-3 border" style={{ background: 'var(--surface-subtle)', borderColor: 'var(--apple-separator)' }}
      aria-labelledby={`${uid}-h`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h4 id={`${uid}-h`} className="text-[13px] font-semibold">Use AI to decide fit</h4>
          <p className="text-[12px] mt-0.5" style={{ color: 'var(--apple-text-secondary)' }}>
            The model judges industry, country, job title and form intent. Your size limits and scores still apply, and
            personal emails and too-small companies are always ruled out. When the model and your rules disagree, a teammate decides.
          </p>
        </div>
        <span className="text-[12px] font-medium px-2 py-0.5 rounded-full border whitespace-nowrap"
          style={state.qualificationAgentEnabled ? { color: 'var(--apple-green)', background: 'var(--tint-green)', borderColor: '#CFE8D7' } : { color: 'var(--apple-text-secondary)', borderColor: 'var(--apple-separator)' }}>
          {state.qualificationAgentEnabled ? 'On' : 'Off'}
        </span>
      </div>

      <div aria-live="polite" className="text-[13px] space-y-1">
        {!run && <p style={{ color: 'var(--apple-text-secondary)' }}>Run the test leads first to see how this model does. They are fictional leads with known right answers.</p>}
        {running && (
          <p>Running test leads… {s?.done ?? 0} of {s?.total ?? '…'} done. Small models on a laptop can take several minutes.</p>
        )}
        {run?.status === 'failed' && (
          <p role="alert" style={{ color: 'var(--apple-red)' }}>The test leads did not finish. {RUN_ERRORS[run.error ?? ''] ?? 'Try again.'}</p>
        )}
        {run?.status === 'completed' && s && (
          <>
            <p>
              <span className="font-medium">{run.model}</span> matched the expected answer on{' '}
              <span className="font-medium">{s.agreed} of {s.total}</span> test leads ({pct(s.agreed, s.total)}%).
              {s.baseline && <> Your rules alone: {s.baseline.agreed} of {s.baseline.total} ({pct(s.baseline.agreed, s.baseline.total)}%).</>}
            </p>
            <ul className="text-[12px] list-disc pl-5" style={{ color: 'var(--apple-text-secondary)' }}>
              {s.injection && <li>Ignored {s.injection.agreed} of {s.injection.total} forms that tried to instruct the AI</li>}
              {typeof s.reviews === 'number' && <li>{s.reviews} would go to a teammate because the model and rules disagree</li>}
              {typeof s.fallbacks === 'number' && s.fallbacks > 0 && <li>{s.fallbacks} unusable answers, where the rules decided instead</li>}
              {s.avgModelLatencyMs != null && <li>About {(s.avgModelLatencyMs / 1000).toFixed(1)} s per lead</li>}
            </ul>
            {!state.matchesCurrentModel && (
              <p style={{ color: 'var(--apple-text-secondary)' }}>This result is for a different model or an older version of the app. Run the test leads again.</p>
            )}
            {run.misses.length > 0 && (
              <div>
                <button type="button" className="text-[12px] font-medium" style={{ color: 'var(--apple-blue)' }}
                  aria-expanded={showMisses} aria-controls={`${uid}-misses`} onClick={() => setShowMisses(v => !v)}>
                  {showMisses ? 'Hide' : 'Show'} the {run.misses.length} test leads it got differently
                </button>
                {showMisses && (
                  <ul id={`${uid}-misses`} className="mt-2 space-y-1 text-[12px]">
                    {run.misses.map(m => (
                      <li key={m.caseId}>
                        {m.description}: expected <span className="font-medium">{fitLabel(m.expected)}</span>, model said{' '}
                        <span className="font-medium">{m.actual ? fitLabel(m.actual) : 'nothing usable'}</span>
                        {m.outcome === 'fallback' && m.fallbackReason ? ` (${FALLBACK_TEXT[m.fallbackReason] ?? 'unusable answer'})` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {run?.status === 'completed' && s?.routing && (
        <div role="group" aria-labelledby={`${uid}-rh`} className="border-t pt-3 space-y-2" style={{ borderColor: 'var(--apple-separator)' }}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h4 id={`${uid}-rh`} className="text-[13px] font-semibold">Use AI to read countries for routing</h4>
              <p className="text-[12px] mt-0.5" style={{ color: 'var(--apple-text-secondary)' }}>
                When a company&apos;s country is written as text (&quot;Deutschland&quot;, &quot;U.S.A.&quot;, &quot;UK&quot;), the model turns it into a country code so
                the lead reaches the right territory. Territories, rep availability, lead limits and round-robin work exactly as before.
              </p>
            </div>
            <span className="text-[12px] font-medium px-2 py-0.5 rounded-full border whitespace-nowrap"
              style={state.routingAgentEnabled ? { color: 'var(--apple-green)', background: 'var(--tint-green)', borderColor: '#CFE8D7' } : { color: 'var(--apple-text-secondary)', borderColor: 'var(--apple-separator)' }}>
              {state.routingAgentEnabled ? 'On' : 'Off'}
            </span>
          </div>
          <p className="text-[13px]">
            Routed <span className="font-medium">{s.routing.agreed} of {s.routing.total}</span> test leads correctly
            ({pct(s.routing.agreed, s.routing.total)}%). Your rules alone: {s.routing.baseline.agreed} of {s.routing.baseline.total}.
            {' '}The model was asked about {s.routing.asked} of them.
          </p>
          {(run.routingMisses ?? []).length > 0 && (
            <ul className="text-[12px] list-disc pl-5" style={{ color: 'var(--apple-text-secondary)' }}>
              {(run.routingMisses ?? []).map(m => (
                <li key={m.caseId}>{m.description}{m.countryRaw ? ` (read "${m.countryRaw}" as ${m.countryCode ?? 'unknown'})` : ''}</li>
              ))}
            </ul>
          )}
          {canEdit && (
            state.routingAgentEnabled
              ? <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void toggle(false, 'routing')}>Turn off</Button>
              : <Button type="button" disabled={busy !== null || !state.routingMatchesCurrentModel} onClick={() => void toggle(true, 'routing')}>Turn on</Button>
          )}
        </div>
      )}

      {error && <p role="alert" className="text-[13px]" style={{ color: 'var(--apple-red)' }}>{error}</p>}

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={busy !== null || running} onClick={() => void start()}>
            {running ? 'Running…' : busy === 'run' ? 'Starting…' : run ? 'Run test leads again' : 'Run test leads'}
          </Button>
          {state.qualificationAgentEnabled ? (
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void toggle(false)}>Turn off</Button>
          ) : (
            <Button type="button" disabled={busy !== null || !state.matchesCurrentModel} onClick={() => void toggle(true)}
              aria-describedby={!state.matchesCurrentModel ? `${uid}-why` : undefined}>
              Turn on
            </Button>
          )}
          {!state.qualificationAgentEnabled && !state.matchesCurrentModel && (
            <span id={`${uid}-why`} className="text-[12px] self-center" style={{ color: 'var(--apple-text-tertiary)' }}>Available after a completed test run with this model.</span>
          )}
        </div>
      )}
    </div>
  )
}
