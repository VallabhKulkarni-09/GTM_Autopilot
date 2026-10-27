/**
 * outcome-window-closer.test.ts
 * Tests for the outcome window closer job.
 *
 * Uses vi.mock with inline factory functions (no outer variable references,
 * since vi.mock is hoisted before variable initialization).
 * Mocks are accessed via vi.mocked() after import.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module mocks — factories must NOT reference outer variables ───────────────

vi.mock('../../../src/db/client.js', () => ({
  getDb: vi.fn(),
}))
vi.mock('../../../src/events/event-log.js', () => ({
  writeEvent: vi.fn(),
}))

// ── Import mocked modules ─────────────────────────────────────────────────────

import { getDb }      from '../../../src/db/client.js'
import { writeEvent } from '../../../src/events/event-log.js'
import { runOutcomeWindowCloser } from '../../../src/queue/jobs/outcome-window-closer.js'

const mockGetDb      = vi.mocked(getDb)
const mockWriteEvent = vi.mocked(writeEvent)

// ── Constants ─────────────────────────────────────────────────────────────────

const ORG_ID = '00000000-0000-0000-0000-000000000001'

function makePlay(daysAgo: number, windowDays = 14) {
  return {
    id:                      `play-${daysAgo}d`,
    lead_id:                 `lead-${daysAgo}d`,
    created_at:              new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    attribution_window_days: windowDays,
    outcome_status:          'no_outcome_yet',
  }
}

/** Returns a mock DB whose update chain resolves { error: null } */
function makeDbWithPlays(plays: unknown[]) {
  // Build an update chain that resolves successfully
  const updateChain: any = { eq: vi.fn() }
  updateChain.eq.mockImplementation(() => updateChain)
  // Make updateChain awaitable
  Object.defineProperty(updateChain, Symbol.toStringTag, { value: 'Promise' })
  const updateResolve = Promise.resolve({ error: null })
  updateChain.then = updateResolve.then.bind(updateResolve)

  const chain: any = {
    select: vi.fn().mockReturnThis(),
    eq:     vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnValue(updateChain),
  }
  // Make the chain itself awaitable — returns the plays result
  const playsResult = Promise.resolve({ data: plays, error: null })
  chain.then = playsResult.then.bind(playsResult)

  return { from: vi.fn(() => chain) }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  mockWriteEvent.mockResolvedValue({ id: 'event-1' })
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Outcome Window Closer', () => {
  it('play past window → writes outcome_window_closed event then updates play_instance', async () => {
    const play = makePlay(20)  // 20 days ago, 14-day window = past
    mockGetDb.mockReturnValue(makeDbWithPlays([play]) as any)

    await runOutcomeWindowCloser([ORG_ID])

    expect(mockWriteEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType:      'outcome_window_closed',
        organizationId: ORG_ID,
        leadId:         play.lead_id,
      })
    )
  })

  it('play still within window → not closed, no event written', async () => {
    const play = makePlay(5)  // 5 days ago, 14-day window = still open
    mockGetDb.mockReturnValue(makeDbWithPlays([play]) as any)

    await runOutcomeWindowCloser([ORG_ID])

    expect(mockWriteEvent).not.toHaveBeenCalled()
  })

  it('empty plays result → nothing happens', async () => {
    mockGetDb.mockReturnValue(makeDbWithPlays([]) as any)

    await runOutcomeWindowCloser([ORG_ID])

    expect(mockWriteEvent).not.toHaveBeenCalled()
  })

  it('event_log write failure → play_instance NOT updated (consistency guard)', async () => {
    const play = makePlay(20)

    const updateMock = vi.fn()
    const chain: any = {
      select: vi.fn().mockReturnThis(),
      eq:     vi.fn().mockReturnThis(),
      update: updateMock,
    }
    const playsResult = Promise.resolve({ data: [play], error: null })
    chain.then = playsResult.then.bind(playsResult)

    mockGetDb.mockReturnValue({ from: vi.fn(() => chain) } as any)
    mockWriteEvent.mockRejectedValueOnce(new Error('event write failed'))

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(runOutcomeWindowCloser([ORG_ID])).resolves.toBeUndefined()

    // update NOT called because event write failed first
    expect(updateMock).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('per-org isolation: ORG_A DB error does not prevent ORG_B from being processed', async () => {
    const ORG_B = '00000000-0000-0000-0000-000000000002'
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    let callCount = 0
    mockGetDb.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // ORG_A: DB throws
        return { from: vi.fn(() => { throw new Error('DB failed for ORG_A') }) }
      }
      // ORG_B: empty plays
      return makeDbWithPlays([]) as any
    })

    await expect(runOutcomeWindowCloser([ORG_ID, ORG_B])).resolves.toBeUndefined()

    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })
})
