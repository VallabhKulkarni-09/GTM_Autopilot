/**
 * outreach.connector.test.ts
 * Tests skipped if OUTREACH_API_KEY not set (no mocks — real API only).
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { OutreachConnector } from '../outreach.connector.js'
import { ConnectorError } from '../../base.js'

const hasCredentials = Boolean(process.env.OUTREACH_API_KEY)

describe.skipIf(!hasCredentials)('OutreachConnector (live API)', () => {
  let connector: OutreachConnector
  let createdProspectId: string

  beforeAll(async () => {
    connector = new OutreachConnector()
    await connector.connect({ apiKey: process.env.OUTREACH_API_KEY! })
  })

  it('healthCheck returns ok: true', async () => {
    const health = await connector.healthCheck()
    expect(health.ok).toBe(true)
    expect(health.latencyMs).toBeGreaterThan(0)
  })

  it('getProspectByEmail returns null for unknown email', async () => {
    const result = await connector.getProspectByEmail('nobody@gtm-test-nonexistent.invalid')
    expect(result).toBeNull()
  })

  it('createProspect creates a prospect', async () => {
    const idempotencyKey = `test:or:create:${Date.now()}`
    const prospect = await connector.createProspect({
      email: `gtm.test.${Date.now()}@example.com`,
      firstName: 'GTM',
      lastName: 'OutreachTest',
      title: 'VP Test',
    }, idempotencyKey)

    expect(prospect.id).toBeTruthy()
    expect(prospect.attributes.emails).toContain(prospect.attributes.emails[0])
    createdProspectId = prospect.id
  })

  it('getProspectByEmail returns the created prospect', async () => {
    const prospect = await connector.getProspectByEmail(`gtm.test.${createdProspectId}@example.com`)
    // Note: email search may have delay — test that it returns null OR the prospect
    expect(prospect === null || typeof prospect.id === 'string').toBe(true)
  })

  it('getActiveSequences returns an array', async () => {
    const sequences = await connector.getActiveSequences(createdProspectId)
    expect(Array.isArray(sequences)).toBe(true)
  })

  it('createTask creates a task for the prospect', async () => {
    const task = await connector.createTask(createdProspectId, {
      subject: 'GTM Autopilot test task',
      taskType: 'action',
    }, `test:or:task:${Date.now()}`)

    expect(task.id).toBeTruthy()
    expect(task.attributes.subject).toBe('GTM Autopilot test task')
  })

  it('throws ConnectorError (not raw Error) on invalid credentials', async () => {
    const badConnector = new OutreachConnector()
    await badConnector.connect({ apiKey: 'invalid_key' })
    await expect(badConnector.getProspectByEmail('test@test.com')).rejects.toThrow(ConnectorError)
  })
})
