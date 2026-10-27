/**
 * webhooks.ts — POST /webhooks/hubspot
 *
 * Rules (non-negotiable):
 * 1. Verify HMAC signature FIRST — 401 if invalid
 * 2. Check idempotency — 200 { status: 'duplicate' } if seen before
 * 3. Enqueue BullMQ job
 * 4. Return 200 { status: 'accepted' } — must complete within 200ms
 * NEVER process synchronously in the webhook handler.
 *
 * NOTE: HubSpot sends an array of event objects, not a single object.
 * Real payload shape: [{ eventId, subscriptionType, portalId, objectId, ... }]
 * eventId is a number in real HubSpot payloads.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { HubSpotConnector } from '../connectors/hubspot/hubspot.connector.js'
import { existsByIdempotencyKey } from '../repositories/event-log.repository.js'
import { addJob } from '../queue/setup.js'
import { resolveHubspotPortal } from '../connectors/factory.js'

const hubspot = new HubSpotConnector()
// Connect lazily — connector.connect() is called at startup in server.ts

declare module 'fastify' {
  interface FastifyRequest { rawBody?: string }
}

/** The URL HubSpot called, as it was signed (behind a tunnel/proxy: forwarded proto + host). */
function signedUrl(request: FastifyRequest): string {
  const proto = String(request.headers['x-forwarded-proto'] ?? request.protocol).split(',')[0].trim()
  const host = String(request.headers['x-forwarded-host'] ?? request.headers.host ?? '').split(',')[0].trim()
  return `${proto}://${host}${request.url}`
}

export async function webhookRoutes(app: FastifyInstance) {
  // Keep the exact bytes HubSpot signed. Scoped to this plugin (webhooks only).
  // Found live: verifying JSON.stringify(parsedBody) failed for a real HubSpot delivery.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    request.rawBody = body as string
    try { done(null, JSON.parse(body as string)) } catch (err) { done(err as Error, undefined) }
  })

  app.post(
    '/hubspot',
    {
      schema: {
        // HubSpot sends an array of event objects
        body: {
          type: 'array',
          items: {
            type: 'object',
            required: ['eventId'],
            properties: {
              eventId:          { type: 'number' },
              subscriptionType: { type: 'string' },
              portalId:         { type: 'number' },
              objectId:         { type: 'number' },   // HubSpot contact ID
              occurredAt:       { type: 'number' },   // epoch ms
              attemptNumber:    { type: 'number' },
              changeSource:     { type: 'string' },
              properties:       { type: 'object' },   // present in some subscription types
            },
          },
          minItems: 1,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // ── 1. Verify signature ────────────────────────────────────────────────
      // IMPORTANT: use the raw body string — not JSON.stringify(parsed body).
      // Re-serialization can alter key order / whitespace, breaking the hash.
      const sigV1 = request.headers['x-hubspot-signature'] as string | undefined
      const sigV3 = request.headers['x-hubspot-signature-v3'] as string | undefined
      const timestamp = request.headers['x-hubspot-request-timestamp'] as string | undefined
      const rawBody = request.rawBody ?? JSON.stringify(request.body)
      const events = request.body as any[]

      // The secret belongs to the workspace that connected this HubSpot portal.
      // Every event in one delivery must come from the same portal.
      const portalIds = new Set(events.map(e => String(e.portalId ?? '')))
      const portalId = [...portalIds][0]
      const unauthorized = () => reply.status(401).send({ error: 'INVALID_SIGNATURE', message: 'Webhook signature verification failed', requestId: request.id })
      if (portalIds.size !== 1 || !portalId) return unauthorized()

      const portal = await resolveHubspotPortal(portalId)
      // v3 (current HubSpot default) when present; v1 for older apps.
      const valid = Boolean(portal) && (
        sigV3
          ? hubspot.verifyWebhookSignatureV3({ method: request.method, url: signedUrl(request), rawBody, timestamp: timestamp ?? '', signature: sigV3, secret: portal!.webhookSecret })
          : hubspot.verifyWebhookSignature(rawBody, sigV1 ?? '', portal!.webhookSecret)
      )
      if (!valid || !portal) {
        // Header names only — never signature values or secrets.
        request.log.warn({ portalId, knownPortal: Boolean(portal), hasV1: Boolean(sigV1), hasV3: Boolean(sigV3), hasTimestamp: Boolean(timestamp), signedUrl: signedUrl(request) }, 'HubSpot webhook rejected')
        return unauthorized()
      }

      // ── 2 & 3. Idempotency + enqueue — one job per event in the batch ──────
      const results: Array<{ eventId: string; status: 'accepted' | 'duplicate' }> = []

      for (const event of events) {
        const eventId = String(event.eventId)
        const idempotencyKey = `hubspot:webhook:${eventId}`

        const alreadyProcessed = await existsByIdempotencyKey(idempotencyKey)
        if (alreadyProcessed) {
          results.push({ eventId, status: 'duplicate' })
          continue
        }

        await addJob('inbound-lead-processing', {
          payload: event,
          // Resolved server-side from the verified portal — never from the payload alone.
          organizationId: portal.organizationId,
          idempotencyKey,
          receivedAt: new Date().toISOString(),
        })

        results.push({ eventId, status: 'accepted' })
      }

      // ── 4. Return 200 immediately ──────────────────────────────────────────
      const accepted = results.filter(r => r.status === 'accepted').map(r => r.eventId)
      const duplicates = results.filter(r => r.status === 'duplicate').map(r => r.eventId)

      return reply.status(200).send({
        status: accepted.length > 0 ? 'accepted' : 'duplicate',
        accepted,
        duplicates,
      })
    }
  )
}
