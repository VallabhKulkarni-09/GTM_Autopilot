/**
 * Model layer unit tests. HTTP is a fake fetch (LLM APIs may be mocked per testing rules);
 * the real Ollama path is exercised by the golden-set run).
 */
import { describe, it, expect, vi } from 'vitest'
import { isBlockedAddress, assertBaseUrlAllowed, UrlBlockedError } from '../url-guard.js'
import { createModelClient, Semaphore } from '../client.js'
import { ModelError, type ModelConfig } from '../types.js'
import { ANTHROPIC_VERSION } from '../adapters.js'

const resolver = async (h: string) => ({ 'host.docker.internal': ['172.17.0.1'], 'evil.example': ['169.254.169.254'], 'mixed.example': ['10.0.0.5', '169.254.1.1'] } as Record<string, string[]>)[h] ?? ['93.184.216.34']
const OLLAMA: ModelConfig = { provider: 'ollama', baseUrl: 'http://host.docker.internal:11434', model: 'qwen2.5:1.5b', apiKey: null }

function fakeFetch(...responses: Array<{ status: number; body: unknown } | Error>) {
  const fn = vi.fn(async (_url: string, _init: RequestInit) => {
    const r = responses.shift()
    if (!r) throw new Error('no more responses')
    if (r instanceof Error) throw r
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status })
  })
  return fn as unknown as typeof fetch & typeof fn
}
const client = (cfg: ModelConfig, f: typeof fetch) => createModelClient(cfg, { fetchImpl: f, resolver, timeoutMs: 1000, retryDelayMs: 1, limiter: new Semaphore(4, 4) })
const CHAT = { system: 'sys', user: 'lead data', maxTokens: 50, json: true }

describe('url guard', () => {
  it.each(['169.254.169.254', '::ffff:169.254.169.254', 'fe80::1', '0.0.0.0', 'fd00:ec2::254', '224.0.0.1', 'not-an-ip'])('blocks %s', a => expect(isBlockedAddress(a)).toBe(true))
  it.each(['127.0.0.1', '::1', '172.17.0.1', '10.1.2.3', '192.168.1.10', '93.184.216.34'])('allows %s (host/Docker/LAN/public)', a => expect(isBlockedAddress(a)).toBe(false))

  it('checks every resolved address and rejects bad URL shapes', async () => {
    await expect(assertBaseUrlAllowed('http://host.docker.internal:11434/', resolver)).resolves.toBeInstanceOf(URL)
    for (const bad of ['http://evil.example', 'http://mixed.example', 'ftp://host.docker.internal', 'http://u:p@host.docker.internal', 'http://host.docker.internal/?x=1', 'nonsense', 'http://[fe80::1]:11434']) {
      await expect(assertBaseUrlAllowed(bad, resolver), bad).rejects.toBeInstanceOf(UrlBlockedError)
    }
  })
})

describe('OpenAI-compatible adapter', () => {
  it('Ollama: calls /v1/chat/completions at temperature 0 with JSON mode, no auth header', async () => {
    const f = fakeFetch({ status: 200, body: { model: 'qwen2.5:1.5b', choices: [{ message: { content: '{"ok":true}' } }] } })
    const res = await client(OLLAMA, f).chat(CHAT)
    expect(res).toMatchObject({ text: '{"ok":true}', provider: 'ollama', model: 'qwen2.5:1.5b', temperature: 0 })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('http://host.docker.internal:11434/v1/chat/completions')
    expect(init.redirect).toBe('error')
    expect((init.headers as Record<string, string>).authorization).toBeUndefined()
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ model: 'qwen2.5:1.5b', temperature: 0, max_tokens: 50, response_format: { type: 'json_object' } })
    expect(body.messages).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: 'lead data' }])
  })

  it('OpenAI: fixed base URL, bearer key, no SSRF lookup', async () => {
    const f = fakeFetch({ status: 200, body: { data: [{ id: 'b' }, { id: 'a' }] } })
    const noResolve = vi.fn()
    const c = createModelClient({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'sk-test' }, { fetchImpl: f, resolver: noResolve, timeoutMs: 1000 })
    expect(await c.listModels()).toEqual(['a', 'b'])
    expect(f.mock.calls[0][0]).toBe('https://api.openai.com/v1/models')
    expect((f.mock.calls[0][1].headers as Record<string, string>).authorization).toBe('Bearer sk-test')
    expect(noResolve).not.toHaveBeenCalled()
  })

  it('Ollama digest comes from /api/tags (":latest" when no tag)', async () => {
    const f = fakeFetch({ status: 200, body: { models: [{ name: 'llama3:latest', digest: 'abc' }] } })
    expect(await client({ ...OLLAMA, model: 'llama3' }, f).modelDigest()).toBe('abc')
    expect(f.mock.calls[0][0]).toBe('http://host.docker.internal:11434/api/tags')
  })

  it('maps HTTP failures to ModelError codes; retries 429/503 up to twice', async () => {
    const cases: Array<[number, string]> = [[401, 'MODEL_AUTH_FAILED'], [404, 'MODEL_NOT_FOUND'], [400, 'MODEL_BAD_REQUEST'], [500, 'MODEL_SERVER_ERROR']]
    for (const [status, code] of cases) {
      const err = await client(OLLAMA, fakeFetch({ status, body: { error: 'x' } })).chat(CHAT).catch(e => e)
      expect(err).toBeInstanceOf(ModelError)
      expect(err).toMatchObject({ code, statusCode: status, source: 'ollama', raw: { error: 'x' } })
    }
    const f = fakeFetch({ status: 503, body: 'busy' }, { status: 200, body: { choices: [{ message: { content: 'hi' } }] } })
    expect((await client(OLLAMA, f).chat(CHAT)).text).toBe('hi')
    const g = fakeFetch({ status: 429, body: {} }, { status: 429, body: {} }, { status: 429, body: {} })
    expect(await client(OLLAMA, g).chat(CHAT).catch(e => e.code)).toBe('MODEL_RATE_LIMITED')
    expect(g).toHaveBeenCalledTimes(3)
  })

  it("Google per-minute limit (array body, 'retry in Ns') is a rate limit: waits and retries, not 'no credits'", async () => {
    // Body shape as returned live by the Gemini OpenAI-compatible endpoint on 2026-10-27 (free tier, 5 RPM).
    const google = [{ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota, please check your plan and billing details. Please retry in 0.01s.' } }]
    const f = fakeFetch({ status: 429, body: google }, { status: 429, body: google }, { status: 200, body: { choices: [{ message: { content: 'ok' } }] } })
    const c = createModelClient({ provider: 'openai_compatible', baseUrl: 'http://host.docker.internal:1234/v1', model: 'gemini-2.5-flash', apiKey: 'k' }, { fetchImpl: f, resolver, timeoutMs: 1000, limiter: new Semaphore(4, 4) })
    expect((await c.chat(CHAT)).text).toBe('ok')
    expect(f).toHaveBeenCalledTimes(3)
    const g = fakeFetch({ status: 429, body: google }, { status: 429, body: google }, { status: 429, body: google })
    expect(await client(OLLAMA, g).chat(CHAT).catch(e => e.code)).toBe('MODEL_RATE_LIMITED')
  })

  it('parses Google waits including hours/minutes (daily limit)', async () => {
    const { retryAfterMs } = await import('../http.js')
    const r = (msg: string, h?: string) => retryAfterMs(new Response('', { headers: h ? { 'retry-after': h } : {} }), [{ error: { message: msg } }])
    expect(r('Please retry in 42.38s.')).toBe(42380)
    expect(r('Please retry in 17h34m7.48820586s.')).toBe(Math.ceil(((17 * 60 + 34) * 60 + 7.48820586) * 1000))
    expect(r('nothing here')).toBeNull()
    expect(r('', '3')).toBe(3000)
  })

  it('a server asking us to wait longer than 60 s is not waited for', async () => {
    const long = [{ error: { message: 'Please retry in 3600s.' } }]
    const f = fakeFetch({ status: 429, body: long })
    const c = createModelClient(OLLAMA, { fetchImpl: f, resolver, timeoutMs: 1000, limiter: new Semaphore(4, 4) })
    expect(await c.chat(CHAT).catch(e => e.code)).toBe('MODEL_RATE_LIMITED')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('429 with an empty balance is MODEL_QUOTA_EXCEEDED and is not retried', async () => {
    // Body shape as returned live by OpenAI on 2026-10-27 for an account with no credits.
    const f = fakeFetch({ status: 429, body: { error: { message: 'You have no credits remaining. Add credits to continue using the API.', type: 'insufficient_quota', code: 'insufficient_quota' } } })
    const err = await client({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk' }, f).chat(CHAT).catch(e => e)
    expect(err).toMatchObject({ code: 'MODEL_QUOTA_EXCEEDED', statusCode: 429, source: 'openai' })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('timeout, network error, blocked URL and odd bodies are typed', async () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' })
    expect(await client(OLLAMA, fakeFetch(timeout)).chat(CHAT).catch(e => e.code)).toBe('MODEL_TIMEOUT')
    expect(await client(OLLAMA, fakeFetch(new TypeError('fetch failed'))).chat(CHAT).catch(e => e.code)).toBe('MODEL_UNREACHABLE')
    const f = fakeFetch()
    expect(await client({ ...OLLAMA, baseUrl: 'http://evil.example' }, f).chat(CHAT).catch(e => e.code)).toBe('MODEL_URL_BLOCKED')
    expect(f).not.toHaveBeenCalled()
    expect(await client(OLLAMA, fakeFetch({ status: 200, body: 'not json' })).chat(CHAT).catch(e => e.code)).toBe('MODEL_BAD_RESPONSE')
    expect(await client(OLLAMA, fakeFetch({ status: 200, body: { choices: [] } })).chat(CHAT).catch(e => e.code)).toBe('MODEL_BAD_RESPONSE')
  })
})

describe('Gemini (OpenAI-compatible endpoint)', () => {
  it('uses Google\'s fixed URL with a bearer key and strips the "models/" prefix from the list', async () => {
    // List shape as returned live by generativelanguage.googleapis.com/v1beta/openai/models on 2026-10-27.
    const f = fakeFetch({ status: 200, body: { object: 'list', data: [{ id: 'models/gemini-3.5-flash-lite', object: 'model', owned_by: 'google' }, { id: 'models/gemini-2.5-flash', object: 'model' }] } })
    const c = createModelClient({ provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'x', apiKey: 'AQ.k' }, { fetchImpl: f, resolver: vi.fn(), timeoutMs: 1000 })
    expect(await c.listModels()).toEqual(['gemini-2.5-flash', 'gemini-3.5-flash-lite'])
    expect(f.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/openai/models')
    expect((f.mock.calls[0][1].headers as Record<string, string>).authorization).toBe('Bearer AQ.k')
    expect(await c.modelDigest()).toBeNull()
  })
})

describe('private-network check', () => {
  it.each([['127.0.0.1', true], ['172.17.0.1', true], ['10.2.3.4', true], ['192.168.1.5', true], ['100.100.1.1', true], ['::1', true], ['fd12::1', true],
    ['142.250.1.95', false], ['93.184.216.34', false], ['2607:f8b0::1', false]])('%s private=%s', async (a, expected) => {
    const { isPrivateAddress } = await import('../url-guard.js')
    expect(isPrivateAddress(a as string)).toBe(expected)
  })
})

describe('Anthropic adapter', () => {
  const CFG: ModelConfig = { provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-x', apiKey: 'ak' }
  it('uses the Messages API with system separate from the untrusted user text', async () => {
    const f = fakeFetch({ status: 200, body: { model: 'claude-x-2026', content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] } })
    const res = await client(CFG, f).chat(CHAT)
    expect(res).toMatchObject({ text: '{"a":1}', model: 'claude-x-2026', provider: 'anthropic' })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.headers).toMatchObject({ 'x-api-key': 'ak', 'anthropic-version': ANTHROPIC_VERSION })
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ model: 'claude-x', temperature: 0, max_tokens: 50, messages: [{ role: 'user', content: 'lead data' }] })
    expect(body.system).toContain('sys')
  })
  it('refuses to build without a key; empty reply is MODEL_BAD_RESPONSE', async () => {
    expect(() => client({ ...CFG, apiKey: null }, fakeFetch())).toThrow(ModelError)
    expect(await client(CFG, fakeFetch({ status: 200, body: { content: [] } })).chat(CHAT).catch(e => e.code)).toBe('MODEL_BAD_RESPONSE')
  })
})

describe('concurrency limit', () => {
  it('runs at most N at once and rejects with MODEL_BUSY when the queue is full', async () => {
    const sem = new Semaphore(2, 1)
    let active = 0, peak = 0
    const release: Array<() => void> = []
    const slow = vi.fn(async (_u: string, _i: RequestInit) => {
      active++; peak = Math.max(peak, active)
      await new Promise<void>(r => release.push(r))
      active--
      return new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const c = createModelClient(OLLAMA, { fetchImpl: slow, resolver, timeoutMs: 5000, limiter: sem })
    const calls = [c.chat(CHAT), c.chat(CHAT), c.chat(CHAT)]
    const busy = await c.chat(CHAT).catch(e => e.code)
    expect(busy).toBe('MODEL_BUSY')
    while (release.length < 2) await new Promise(r => setTimeout(r, 1))
    release.splice(0).forEach(r => r())
    while (release.length < 1) await new Promise(r => setTimeout(r, 1))
    release.splice(0).forEach(r => r())
    await Promise.all(calls)
    expect(peak).toBe(2)
  })
})
