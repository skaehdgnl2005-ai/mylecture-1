/**
 * Per-device quota fold for the teacher's 기기별 남은 횟수 panel.
 *
 * Pure and free of any db import, so the quota rule below is unit-testable
 * (device-usage.test.ts) — including the expired-lease branch, which no
 * end-to-end test can produce on demand.
 *
 * Deliberately does NOT `import 'server-only'`: nothing secret lives here (the
 * labels are the anonymous '파란 여우' strings) and the type is shared with the
 * client component that renders it.
 */

export interface QuotaDeviceRow {
  id: string
  label: string
  reset_at: string | null
}

export interface QuotaJobRow {
  device_id: string
  status: 'queued' | 'running' | 'done' | 'failed'
  created_at: string
  lease_expires_at: string | null
}

export interface DeviceUsage {
  id: string
  label: string
  /** Finished pictures. The same rows the teacher sees in the 그림 grid. */
  count: number
  /** Attempts held against the per-device quota. Mirrors used_quota(). */
  used: number
  resetAt: string | null
}

/**
 * KEEP IN SYNC WITH used_quota() IN supabase/migrations/0002_claim_job.sql.
 * Same three clauses, same order:
 *
 *   status in ('queued','done')
 *   or (status = 'running' and lease_expires_at > now())
 *   and created_at > coalesce(reset_at, '-infinity')
 *
 * Duplicated rather than called because used_quota() takes ONE device and the
 * dashboard polls every 4 seconds for ~20 of them. If the SQL rule changes,
 * change this too — device-usage.test.ts pins the two together.
 *
 * `now` is the app server's clock, not Postgres's. The only clause it touches is
 * the 3-minute lease window, so a little skew can at worst make one row read one
 * attempt off for a few seconds. Enforcement is unaffected: the database
 * decides, this number only informs.
 *
 * An image COUNT cannot stand in for this. A queued job holds an attempt but has
 * produced no image yet, and reset_at — the thing the 횟수 초기화 button sets —
 * does not move the image count at all.
 */
export function foldDeviceUsage(
  devices: readonly QuotaDeviceRow[],
  jobs: readonly QuotaJobRow[],
  images: readonly { device_id: string }[],
  now: number = Date.now(),
): DeviceUsage[] {
  const resetAt = new Map<string, number>(
    devices.map((d) => [d.id, d.reset_at ? Date.parse(d.reset_at) : Number.NEGATIVE_INFINITY]),
  )

  const used = new Map<string, number>()
  for (const j of jobs) {
    const alive =
      j.status === 'queued' ||
      j.status === 'done' ||
      (j.status === 'running' && j.lease_expires_at !== null && Date.parse(j.lease_expires_at) > now)
    if (!alive) continue
    // Strictly greater, exactly as the SQL has it: a job created in the same
    // millisecond as the reset does not survive it.
    if (Date.parse(j.created_at) <= (resetAt.get(j.device_id) ?? Number.NEGATIVE_INFINITY)) continue
    used.set(j.device_id, (used.get(j.device_id) ?? 0) + 1)
  }

  const count = new Map<string, number>()
  for (const i of images) count.set(i.device_id, (count.get(i.device_id) ?? 0) + 1)

  return devices
    .map((d) => ({
      id: d.id,
      label: d.label,
      count: count.get(d.id) ?? 0,
      used: used.get(d.id) ?? 0,
      resetAt: d.reset_at,
    }))
    // Stable alphabetical order. The panel repaints every 4 seconds; sorting by
    // anything that moves (used, count) would slide the button out from under
    // the teacher's finger mid-click. The id tiebreaker matters because labels
    // are NOT unique — anonymous_label() has 12 x 15 = 180 combinations, so in a
    // class of 20 a collision is likelier than not, and without it two rows with
    // the same label could swap places between polls.
    .sort((a, b) => a.label.localeCompare(b.label, 'ko') || a.id.localeCompare(b.id))
}
