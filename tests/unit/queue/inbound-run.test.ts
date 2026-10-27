import { describe, it, expect } from 'vitest'
import { findExistingRun } from '../../../src/queue/workers/inbound-run.js'

/** Minimal Supabase query-builder fake: records filters, returns canned rows per table. */
function fakeDb(tables: Record<string, any>) {
  const calls: { table: string; filters: [string, string, unknown][] }[] = []
  const db = {
    from(table: string) {
      const call = { table, filters: [] as [string, string, unknown][] }
      calls.push(call)
      const result = tables[table]
      const chain: any = {
        select: () => chain,
        eq: (c: string, v: unknown) => { call.filters.push(['eq', c, v]); return chain },
        contains: (c: string, v: unknown) => { call.filters.push(['contains', c, v]); return chain },
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: result?.[0] ?? null, error: null }),
        then: (res: any) => res(table === 'event_log' ? { count: result, error: null } : { data: result, error: null }),
      }
      return chain
    },
  }
  return { db: db as any, calls }
}

describe('findExistingRun (retry safety)', () => {
  it('first attempt: no earlier lead → null', async () => {
    const { db } = fakeDb({ leads: [] })
    expect(await findExistingRun(db, 'org-a', 594493280)).toBeNull()
  })

  it('retry after the play was created: returns the same lead, play and run id', async () => {
    const { db, calls } = fakeDb({ leads: [{ id: 'lead-1' }], play_instance: [{ id: 'play-1', workflow_run_id: '1' }], event_log: 1 })
    expect(await findExistingRun(db, 'org-a', 594493280)).toEqual({
      leadId: 'lead-1', playInstanceId: 'play-1', workflowRunId: '1', webhookEventWritten: true,
    })
    // Always scoped to the workspace, matched on the source event id
    for (const c of calls) expect(c.filters).toContainEqual(['eq', 'organization_id', 'org-a'])
    expect(calls[0].filters).toContainEqual(['contains', 'raw_payload', { eventId: 594493280 }])
  })

  it('retry after only the lead was inserted: returns the lead with no play', async () => {
    const { db } = fakeDb({ leads: [{ id: 'lead-1' }], play_instance: [] })
    expect(await findExistingRun(db, 'org-a', 1)).toEqual({ leadId: 'lead-1', playInstanceId: null, workflowRunId: null, webhookEventWritten: false })
  })

  it('reports when the webhook_received event was not yet written', async () => {
    const { db } = fakeDb({ leads: [{ id: 'l' }], play_instance: [{ id: 'p', workflow_run_id: '7' }], event_log: 0 })
    expect((await findExistingRun(db, 'org-a', 1))?.webhookEventWritten).toBe(false)
  })

  it('no source event id → null (cannot match safely)', async () => {
    const { db } = fakeDb({ leads: [{ id: 'l' }] })
    expect(await findExistingRun(db, 'org-a', undefined)).toBeNull()
  })
})
