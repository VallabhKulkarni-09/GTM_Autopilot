import { describe, it, expect } from 'vitest'
import { summarizeOutcomes } from '../../src/routes/api/metrics.js'

describe('summarizeOutcomes', () => {
  it('counts completed plays separately from meetings', () => {
    const r = summarizeOutcomes([
      { status: 'completed', outcome_status: 'no_outcome_yet' },
      { status: 'completed', outcome_status: 'meeting_booked' },
      { status: 'nurture',   outcome_status: 'no_meeting' },
      { status: 'running',   outcome_status: null },
    ])
    expect(r.playsCompleted).toBe(2)
    // 1 booked / (1 booked + 1 no_meeting) = 50%
    expect(r.meeting_rate).toBe(50)
  })

  it('returns null meeting_rate when no attribution window has closed', () => {
    const r = summarizeOutcomes([{ status: 'completed', outcome_status: 'no_outcome_yet' }])
    expect(r.playsCompleted).toBe(1)
    expect(r.meeting_rate).toBeNull()
  })

  it('handles empty input', () => {
    expect(summarizeOutcomes([])).toEqual({ playsCompleted: 0, meeting_rate: null })
  })
})
