import { describe, it, expect } from 'vitest'
import { foldDeviceUsage, type QuotaDeviceRow, type QuotaJobRow } from './device-usage'

/**
 * These tests are what stop the teacher screen's 남은 횟수 drifting away from the
 * number the server actually enforces. Every case below mirrors one clause of
 * used_quota() in supabase/migrations/0002_claim_job.sql:
 *
 *   status in ('queued','done')
 *   or (status = 'running' and lease_expires_at > now())
 *   and created_at > coalesce(reset_at, '-infinity')
 */

const NOW = Date.parse('2026-09-06T10:00:00.000Z')
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

const device = (id: string, label: string, reset_at: string | null = null): QuotaDeviceRow => ({
  id,
  label,
  reset_at,
})

const job = (
  device_id: string,
  status: QuotaJobRow['status'],
  createdOffset: number,
  lease_expires_at: string | null = null,
): QuotaJobRow => ({ device_id, status, created_at: at(createdOffset), lease_expires_at })

describe('foldDeviceUsage mirrors used_quota()', () => {
  it('counts queued and done, never failed', () => {
    const [row] = foldDeviceUsage(
      [device('d1', '파란 여우')],
      [job('d1', 'queued', -60_000), job('d1', 'done', -120_000), job('d1', 'failed', -30_000)],
      [],
      NOW,
    )
    // PRD §5-3: a failed generation does not consume an attempt.
    expect(row.used).toBe(2)
  })

  it('counts a running job only while its lease is alive', () => {
    const alive = foldDeviceUsage(
      [device('d1', '파란 여우')],
      [job('d1', 'running', -10_000, at(60_000))],
      [],
      NOW,
    )
    expect(alive[0].used).toBe(1)

    // A crashed worker's lease expires after 3 minutes and the attempt comes
    // back to the student without any reaper having run.
    const expired = foldDeviceUsage(
      [device('d1', '파란 여우')],
      [job('d1', 'running', -300_000, at(-1000))],
      [],
      NOW,
    )
    expect(expired[0].used).toBe(0)

    // A running row with no lease at all must not be counted either.
    const noLease = foldDeviceUsage(
      [device('d1', '파란 여우')],
      [job('d1', 'running', -10_000, null)],
      [],
      NOW,
    )
    expect(noLease[0].used).toBe(0)
  })

  it('ignores jobs created at or before reset_at — this is what the button changes', () => {
    const resetAt = at(-60_000)
    const [row] = foldDeviceUsage(
      [device('d1', '파란 여우', resetAt)],
      [
        job('d1', 'done', -120_000), // before the reset
        job('d1', 'done', -60_000), // exactly at it: SQL uses strict >, so excluded
        job('d1', 'queued', -10_000), // after it
      ],
      [],
      NOW,
    )
    expect(row.used).toBe(1)
  })

  it('never lets a reset move the picture count — that is why `used` exists', () => {
    const [row] = foldDeviceUsage(
      [device('d1', '파란 여우', at(-60_000))],
      [job('d1', 'done', -120_000)],
      [{ device_id: 'd1' }, { device_id: 'd1' }],
      NOW,
    )
    expect(row.used).toBe(0)
    expect(row.count).toBe(2)
  })

  it('a queued job holds an attempt before any picture exists (the normal mid-class state)', () => {
    const [row] = foldDeviceUsage([device('d1', '파란 여우')], [job('d1', 'queued', -5_000)], [], NOW)
    expect(row.used).toBe(1)
    expect(row.count).toBe(0)
  })

  it('keeps devices apart and returns every enrolled device', () => {
    const rows = foldDeviceUsage(
      [device('d1', '파란 여우'), device('d2', '노란 곰')],
      [job('d1', 'done', -1000), job('d2', 'failed', -1000)],
      [{ device_id: 'd1' }],
      NOW,
    )
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.id === 'd1')).toMatchObject({ used: 1, count: 1 })
    expect(rows.find((r) => r.id === 'd2')).toMatchObject({ used: 0, count: 0 })
  })

  it('sorts by label so a 4-second repaint cannot slide the button under the finger', () => {
    const rows = foldDeviceUsage(
      [device('d1', '파란 여우'), device('d2', '노란 곰'), device('d3', '빨간 매')],
      [job('d1', 'done', -1000), job('d1', 'done', -2000)],
      [],
      NOW,
    )
    expect(rows.map((r) => r.label)).toEqual(['노란 곰', '빨간 매', '파란 여우'])
  })

  it('carries reset_at through untouched so the panel can show the badge', () => {
    const resetAt = at(-60_000)
    const [row] = foldDeviceUsage([device('d1', '파란 여우', resetAt)], [], [], NOW)
    expect(row.resetAt).toBe(resetAt)
  })
})
