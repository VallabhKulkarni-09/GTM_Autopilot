/**
 * salesforce.connector.test.ts
 * Tests skipped if SF_CLIENT_ID is not set in env (no mocks — real sandbox only).
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { SalesforceConnector } from '../salesforce.connector.js'
import { ConnectorError } from '../../base.js'
import type { SalesforceConfig } from '../salesforce.types.js'

const hasCredentials = Boolean(process.env.SF_CLIENT_ID)

const config: SalesforceConfig = {
  instanceUrl:  process.env.SF_INSTANCE_URL   ?? '',
  clientId:     process.env.SF_CLIENT_ID      ?? '',
  clientSecret: process.env.SF_CLIENT_SECRET  ?? '',
  sandbox:      process.env.SF_SANDBOX        === 'true',
}

describe.skipIf(!hasCredentials)('SalesforceConnector (live sandbox)', () => {
  let connector: SalesforceConnector
  let createdLeadId: string

  beforeAll(async () => {
    connector = new SalesforceConnector()
    await connector.connect(config)
  })

  it('healthCheck returns ok: true', async () => {
    const health = await connector.healthCheck()
    expect(health.ok).toBe(true)
    expect(health.latencyMs).toBeGreaterThan(0)
    expect(health.lastChecked).toBeInstanceOf(Date)
  })

  it('createLead creates a lead and returns SalesforceLead', async () => {
    const idempotencyKey = `test:sf:create:${Date.now()}`
    const lead = await connector.createLead({
      firstName: 'GTM',
      lastName: 'TestLead',
      email: `gtm.test.${Date.now()}@example.com`,
      company: 'GTM Autopilot Test Co',
      leadSource: 'Web',
    }, idempotencyKey)

    expect(lead.Id).toBeTruthy()
    expect(lead.Email).toContain('@example.com')
    createdLeadId = lead.Id
  })

  it('getLeadById returns the created lead', async () => {
    const lead = await connector.getLeadById(createdLeadId)
    expect(lead.Id).toBe(createdLeadId)
    expect(lead.LastName).toBe('TestLead')
  })

  it('getLeadById throws ConnectorError (not raw Error) on 404', async () => {
    await expect(connector.getLeadById('000000000000000AAA')).rejects.toThrow(ConnectorError)
  })

  it('updateLead updates the lead title', async () => {
    await expect(
      connector.updateLead(createdLeadId, { Title: 'Updated VP Test' } as any, `test:sf:update:${Date.now()}`)
    ).resolves.not.toThrow()
  })

  it('assignLeadOwner assigns the lead to a user', async () => {
    const users = await connector.getUsers({ isActive: true })
    expect(users.length).toBeGreaterThan(0)
    const ownerId = users[0].Id

    await expect(
      connector.assignLeadOwner(createdLeadId, ownerId, `test:sf:assign:${Date.now()}`)
    ).resolves.not.toThrow()
  })

  it('createTask creates a task linked to the lead', async () => {
    const users = await connector.getUsers({ isActive: true })
    const task = await connector.createTask(createdLeadId, {
      subject: 'GTM Autopilot test task',
      ownerId: users[0].Id,
    }, `test:sf:task:${Date.now()}`)

    expect(task.Id).toBeTruthy()
    expect(task.WhoId).toBe(createdLeadId)
  })

  it('getUsers returns active users array', async () => {
    const users = await connector.getUsers({ isActive: true })
    expect(Array.isArray(users)).toBe(true)
    expect(users.length).toBeGreaterThan(0)
    expect(users[0].Id).toBeTruthy()
  })

  it('throws ConnectorError (not raw Error) on invalid credentials', async () => {
    const badConnector = new SalesforceConnector()
    await expect(
      badConnector.connect({ ...config, clientSecret: 'invalid_secret' })
    ).rejects.toThrow(ConnectorError)
  })
})
