'use client'
import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import type { AiModelSettings, AiModelProvider, AiModelEvaluationState } from '@/types/api'
import { AiAgentPanel } from './ai-agent-panel'

const PROVIDERS: Array<{ value: AiModelProvider; label: string; local: boolean; keyHelp?: string }> = [
  { value: 'ollama', label: 'Ollama on your machine', local: true },
  { value: 'openai_compatible', label: 'Other server on your network (OpenAI-compatible)', local: true },
  { value: 'gemini', label: 'Google Gemini', local: false, keyHelp: 'Create one at aistudio.google.com › Get API key.' },
  { value: 'anthropic', label: 'Anthropic', local: false, keyHelp: 'Create one at console.anthropic.com › API keys.' },
  { value: 'openai', label: 'OpenAI', local: false, keyHelp: 'Create one at platform.openai.com › API keys.' },
  { value: 'openrouter', label: 'OpenRouter', local: false, keyHelp: 'Create one at openrouter.ai › Keys.' },
]
const providerLabel = (p: AiModelProvider | null) => PROVIDERS.find(x => x.value === p)?.label ?? ''
const DEFAULT_OLLAMA_URL = 'http://ollama.internal:11434'

type Result = { ok: boolean; text: string; fix?: string; warn?: string }

const inputCls = 'w-full h-9 px-3 rounded-[7px] text-[13px] border border-[color:var(--border-strong)] bg-white outline-none focus:border-[color:var(--apple-blue)] focus:ring-[3px] focus:ring-[#2B59C3]/15'

export function AiModelCard({ settings, evaluation, canEdit }: { settings: AiModelSettings; evaluation: AiModelEvaluationState | null; canEdit: boolean }) {
  const router = useRouter()
  const uid = useId()
  const id = (k: string) => `${uid}-${k}`
  const [open, setOpen] = useState(false)
  const [provider, setProvider] = useState<AiModelProvider>(settings.provider ?? 'ollama')
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl ?? settings.suggestedOllamaUrl ?? DEFAULT_OLLAMA_URL)
  const [model, setModel] = useState(settings.model ?? '')
  const [apiKey, setApiKey] = useState('')
  const [consent, setConsent] = useState(false)
  // "Other server" on a public address: the API says so (CONSENT_REQUIRED) and we ask, like a cloud provider.
  const [publicServer, setPublicServer] = useState(false)
  const [models, setModels] = useState<string[] | null>(null)
  const [busy, setBusy] = useState<null | 'models' | 'test' | 'save' | 'remove'>(null)
  const [result, setResult] = useState<Result | null>(null)

  const def = PROVIDERS.find(p => p.value === provider)!
  const needsConsent = !def.local || publicServer
  const keySaved = settings.hasApiKey && settings.provider === provider
  const status = !settings.configured ? 'Not set up' : settings.lastTest?.ok === false ? 'Needs attention' : 'Connected'

  function body(extra: Record<string, unknown> = {}) {
    return JSON.stringify({
      provider,
      ...(def.local ? { baseUrl } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(apiKey.trim() && provider !== 'ollama' ? { apiKey: apiKey.trim() } : {}),
      ...extra,
    })
  }

  async function call(kind: 'models' | 'test' | 'save' | 'remove') {
    if ((kind === 'test' || kind === 'save') && !model.trim()) {
      setResult({ ok: false, text: 'Choose a model first.' }); return
    }
    setBusy(kind); setResult(null)
    try {
      const res = kind === 'remove'
        ? await fetch('/api/ai-model', { method: 'DELETE' })
        : await fetch(kind === 'save' ? '/api/ai-model' : `/api/ai-model/${kind}`, {
            method: kind === 'save' ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body(kind === 'save' && needsConsent ? { consent } : {}),
          })
      if (kind === 'remove') {
        if (res.ok) { setResult({ ok: true, text: 'AI model disconnected. The rules decide every lead.' }); router.refresh() }
        else setResult({ ok: false, text: 'Could not disconnect. Try again.' })
        return
      }
      const data = await res.json().catch(() => ({}))
      if (data.error === 'CONSENT_REQUIRED' && def.local) setPublicServer(true)
      if (kind === 'test' && def.local) setPublicServer(Boolean(data.leavesNetwork))
      if (!res.ok || !data.ok) { setResult({ ok: false, text: data.message ?? 'Could not connect.', fix: data.fix }); return }
      if (kind === 'models') {
        setModels(data.models)
        setResult({ ok: true, text: data.models.length ? `Found ${data.models.length} models.` : 'The server has no models yet.', fix: undefined })
        return
      }
      const secs = (data.latencyMs / 1000).toFixed(1)
      const warn = data.jsonOk ? undefined : 'This model did not follow the answer format in the check. Small models often do this; when it happens on a real lead, the rules decide instead.'
      const off = kind === 'save' && data.agentsTurnedOff ? ' AI decisions were turned off because the model changed; run the test leads again.' : ''
      setResult({ ok: true, text: kind === 'save' ? `Saved. The model answered in ${secs} s.${off}` : `Connection works. The model answered in ${secs} s.`, warn })
      if (kind === 'save') { setApiKey(''); router.refresh() }
    } catch {
      setResult({ ok: false, text: 'Could not reach the server. Check your connection and try again.' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="apple-card p-5 space-y-4" aria-labelledby={id('title')}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 id={id('title')} className="text-[14px] font-semibold">AI model <span className="font-normal" style={{ color: 'var(--apple-text-tertiary)' }}>(optional)</span></h3>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--apple-text-secondary)' }}>
            The built-in rules decide every lead. A model can add judgement later, and is only used after it passes your test leads.
          </p>
          {settings.configured && (
            <p className="text-[12px] mt-1" style={{ color: 'var(--apple-text-tertiary)' }}>
              {providerLabel(settings.provider)} · {settings.model} · {settings.dataLeavesMachine ? `Lead data is sent to ${providerLabel(settings.provider)}` : 'Lead data stays on your machine'}
            </p>
          )}
        </div>
        <span className="text-[12px] font-medium px-2 py-0.5 rounded-full border whitespace-nowrap"
          style={status === 'Connected' ? { color: 'var(--apple-green)', background: 'var(--tint-green)', borderColor: '#CFE8D7' }
            : status === 'Needs attention' ? { color: 'var(--apple-red)', background: 'var(--tint-red)', borderColor: '#F6D5D2' }
            : { color: 'var(--apple-text-secondary)', borderColor: 'var(--apple-separator)' }}>
          {status}
        </span>
      </div>

      {settings.configured && evaluation && <AiAgentPanel initial={evaluation} canEdit={canEdit} />}

      {canEdit ? (
        <button type="button" aria-expanded={open} aria-controls={id('form')} onClick={() => setOpen(o => !o)}
          className="text-[13px] font-medium" style={{ color: 'var(--apple-blue)' }}>
          {open ? 'Hide setup' : settings.configured ? 'Change model' : 'Set up'}
          <span className="sr-only"> for AI model</span>
        </button>
      ) : (
        !settings.configured && <p className="text-[12px]" style={{ color: 'var(--apple-text-tertiary)' }}>Ask an admin to set up an AI model.</p>
      )}

      {open && canEdit && (
        <form id={id('form')} className="space-y-4" onSubmit={e => { e.preventDefault(); void call('save') }}>
          <div className="space-y-1">
            <label htmlFor={id('provider')} className="text-[13px] font-medium block">Where the model runs</label>
            <select id={id('provider')} value={provider} className={inputCls}
              onChange={e => { setProvider(e.target.value as AiModelProvider); setModels(null); setResult(null); setConsent(false); setPublicServer(false) }}>
              {PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>

          {def.local ? (
            <div className="space-y-1">
              <label htmlFor={id('url')} className="text-[13px] font-medium block">Server address</label>
              <input id={id('url')} value={baseUrl} onChange={e => { setBaseUrl(e.target.value); setPublicServer(false); setConsent(false) }} autoComplete="off" spellCheck={false}
                placeholder={provider === 'ollama' ? DEFAULT_OLLAMA_URL : 'http://host.docker.internal:1234/v1'} aria-describedby={id('url-help')} className={inputCls} />
              <p id={id('url-help')} className="text-[12px]" style={{ color: 'var(--apple-text-tertiary)' }}>
                {provider === 'ollama'
                  ? 'On Linux, start the Ollama connector first: docker compose --profile ollama up -d. On Docker Desktop use http://host.docker.internal:11434.'
                  : 'The address of an OpenAI-compatible API, such as LM Studio or vLLM, usually ending in /v1.'}
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              <label htmlFor={id('key')} className="text-[13px] font-medium block">API key</label>
              <input id={id('key')} type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} autoComplete="off" spellCheck={false}
                placeholder={keySaved ? 'Saved. Leave blank to keep the current key.' : ''} aria-describedby={id('key-help')} className={inputCls} />
              <p id={id('key-help')} className="text-[12px]" style={{ color: 'var(--apple-text-tertiary)' }}>{def.keyHelp} Stored encrypted for this workspace only.</p>
            </div>
          )}

          <div className="space-y-1">
            <label htmlFor={id('model')} className="text-[13px] font-medium block">Model</label>
            <div className="flex gap-2">
              <input id={id('model')} list={models ? id('models') : undefined} value={model} onChange={e => setModel(e.target.value)}
                autoComplete="off" spellCheck={false} placeholder={provider === 'ollama' ? 'for example qwen2.5:7b' : 'model name'} className={inputCls} />
              <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void call('models')}>
                {busy === 'models' ? 'Loading…' : 'Load models'}
              </Button>
            </div>
            {models && <datalist id={id('models')}>{models.map(m => <option key={m} value={m} />)}</datalist>}
            {models && models.length > 0 && (
              <ul className="flex flex-wrap gap-1.5 pt-1" aria-label="Available models">
                {models.slice(0, 30).map(m => (
                  <li key={m}>
                    <button type="button" onClick={() => setModel(m)} aria-pressed={model === m}
                      className="text-[12px] px-2 py-0.5 rounded-full border"
                      style={model === m ? { borderColor: 'var(--ink)', color: 'var(--ink)' } : { borderColor: 'var(--apple-separator)', color: 'var(--apple-text-secondary)' }}>
                      {m}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {needsConsent && (
            <label className="flex items-start gap-2 text-[13px]">
              <input type="checkbox" className="mt-0.5" checked={consent} onChange={e => setConsent(e.target.checked)} />
              <span>
                I understand that lead details (job title, email domain, form answers and company facts) will be sent to{' '}
                {def.local ? 'this server, which is on the internet, not my own network,' : def.label} when the AI model is used.
              </span>
            </label>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void call('test')}>
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </Button>
            <Button type="submit" disabled={busy !== null || (needsConsent && !consent)}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
            {settings.configured && (
              <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void call('remove')}>
                {busy === 'remove' ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            )}
          </div>
        </form>
      )}

      {result && (
        <div role={result.ok ? 'status' : 'alert'} className="rounded-[8px] p-3 text-[13px] border"
          style={{ background: result.ok ? 'var(--tint-green)' : 'var(--tint-red)', borderColor: result.ok ? '#CFE8D7' : '#F6D5D2' }}>
          <div className="font-medium" style={{ color: result.ok ? 'var(--apple-green)' : 'var(--apple-red)' }}>{result.text}</div>
          {!result.ok && result.fix && <div className="mt-1" style={{ color: 'var(--apple-text-secondary)' }}>How to fix: {result.fix}</div>}
          {result.warn && <div className="mt-1" style={{ color: 'var(--apple-text-secondary)' }}>{result.warn}</div>}
        </div>
      )}
    </section>
  )
}
