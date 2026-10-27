/**
 * Webhook signatures are checked with the secret of the workspace that owns the portal.
 * Org B's secret must never validate a request for org A's portal (and vice versa).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import Fastify from 'fastify'
import { createHash, createHmac } from 'crypto'

const { addJob } = vi.hoisted(() => ({ addJob: vi.fn() }))
vi.mock('../../src/queue/setup.js', () => ({ addJob }))
vi.mock('../../src/repositories/event-log.repository.js', () => ({ existsByIdempotencyKey: vi.fn(async () => false) }))
vi.mock('../../src/connectors/factory.js', () => ({
  resolveHubspotPortal: vi.fn(async (portalId: string) => ({
    '111': { organizationId: 'org-a', webhookSecret: 'secret-a' },
    '222': { organizationId: 'org-b', webhookSecret: 'secret-b' },
  } as Record<string, unknown>)[portalId] ?? null),
}))

const { webhookRoutes } = await import('../../src/routes/webhooks.js')

const app = Fastify({ logger: false })
beforeAll(async () => { await app.register(webhookRoutes, { prefix: '/webhooks' }); await app.ready() })

const sign = (secret: string, body: string) => createHash('sha256').update(secret + body).digest('hex')
const send = (events: unknown[], secret: string) => {
  const body = JSON.stringify(events)
  return app.inject({ method: 'POST', url: '/webhooks/hubspot', headers: { 'content-type': 'application/json', 'x-hubspot-signature': sign(secret, body) }, payload: body })
}

const signV3 = (secret: string, url: string, body: string, ts: string) =>
  createHmac('sha256', secret).update(`POST${url}${body}${ts}`).digest('base64')
const HOST = 'hooks.example.com'
const URL3 = `https://${HOST}/webhooks/hubspot`
const sendV3 = (body: string, secret: string, opts: { ts?: string; bodySent?: string } = {}) => {
  const ts = opts.ts ?? String(Date.now())
  return app.inject({
    method: 'POST', url: '/webhooks/hubspot', payload: opts.bodySent ?? body,
    headers: {
      'content-type': 'application/json', host: HOST, 'x-forwarded-proto': 'https',
      'x-hubspot-request-timestamp': ts, 'x-hubspot-signature-v3': signV3(secret, URL3, body, ts),
    },
  })
}

describe('HubSpot webhook — v3 signature (current HubSpot default)', () => {
  // Spacing differs from JSON.stringify on purpose: the exact bytes must be verified.
  const raw = '[ { "eventId": 11, "portalId": 111, "objectId": 5 } ]'

  it('accepts a valid v3 signature over the exact raw body and full URL', async () => {
    addJob.mockClear()
    const res = await sendV3(raw, 'secret-a')
    expect(res.statusCode).toBe(200)
    expect(addJob).toHaveBeenCalledWith('inbound-lead-processing', expect.objectContaining({ organizationId: 'org-a' }))
  })

  it('rejects another workspace\'s secret', async () => {
    expect((await sendV3(raw, 'secret-b')).statusCode).toBe(401)
  })

  it('rejects a timestamp older than 5 minutes (replay)', async () => {
    expect((await sendV3(raw, 'secret-a', { ts: String(Date.now() - 6 * 60_000) })).statusCode).toBe(401)
  })

  it('rejects a body changed after signing', async () => {
    expect((await sendV3(raw, 'secret-a', { bodySent: raw.replace('5', '6') })).statusCode).toBe(401)
  })
})

describe('HubSpot webhook — per-workspace signature', () => {
  it('accepts a correctly signed event and enqueues it for the owning workspace', async () => {
    addJob.mockClear()
    const res = await send([{ eventId: 1, portalId: 111, objectId: 5 }], 'secret-a')
    expect(res.statusCode).toBe(200)
    expect(addJob).toHaveBeenCalledWith('inbound-lead-processing', expect.objectContaining({ organizationId: 'org-a' }))
  })

  it('rejects an event for portal A signed with workspace B\'s secret', async () => {
    addJob.mockClear()
    const res = await send([{ eventId: 2, portalId: 111, objectId: 5 }], 'secret-b')
    expect(res.statusCode).toBe(401)
    expect(addJob).not.toHaveBeenCalled()
  })

  it('rejects an unknown portal', async () => {
    expect((await send([{ eventId: 3, portalId: 999 }], 'secret-a')).statusCode).toBe(401)
  })

  it('rejects a batch mixing portals', async () => {
    expect((await send([{ eventId: 4, portalId: 111 }, { eventId: 5, portalId: 222 }], 'secret-a')).statusCode).toBe(401)
  })

  it('rejects events with no portalId', async () => {
    expect((await send([{ eventId: 6 }], 'secret-a')).statusCode).toBe(401)
  })
})
