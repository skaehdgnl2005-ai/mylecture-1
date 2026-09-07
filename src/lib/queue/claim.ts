import 'server-only'
import { db, type JobRow, type SessionRow } from '@/lib/db'
import { env, spacingMs } from '@/lib/env'
import { claimedRow } from './claimed-row'

/**
 * Thin, typed wrappers over the SQL in 0002_claim_job.sql. All of the
 * correctness lives in the database, on purpose: on Vercel, many lambdas run
 * concurrently and autoscale, so any in-process semaphore would silently permit
 * `limit x instanceCount`.
 */

export async function claimJob(session: Pick<SessionRow, 'per_minute_limit' | 'queue_order'>): Promise<JobRow | null> {
  const cfg = env()
  // The session value is clamped by the account's real ceiling: a well-meaning
  // teacher must not be able to turn a working class into a 429 storm.
  const ipm = Math.min(session.per_minute_limit, cfg.OPENAI_IPM)

  const { data, error } = await db().rpc('claim_job', {
    p_spacing_ms: spacingMs(ipm),
    p_max_in_flight: cfg.MAX_IN_FLIGHT,
    p_order: session.queue_order,
  })
  if (error) throw new Error(`claim_job failed: ${error.message}`)
  return claimedRow(data)
}

export async function msUntilSlot(): Promise<number> {
  const { data, error } = await db().rpc('ms_until_slot')
  if (error) return spacingMs()
  return typeof data === 'number' ? data : 0
}

export async function queuePosition(jobId: string, order: string): Promise<number> {
  const { data, error } = await db().rpc('queue_position', { p_job: jobId, p_order: order })
  if (error) return 0
  return typeof data === 'number' ? data : 0
}

export async function usedQuota(sessionCode: string, deviceId: string): Promise<number> {
  const { data, error } = await db().rpc('used_quota', {
    p_session: sessionCode,
    p_device: deviceId,
  })
  if (error) throw new Error(`used_quota failed: ${error.message}`)
  return typeof data === 'number' ? data : 0
}

export async function reapExpiredLeases(): Promise<number> {
  const { data, error } = await db().rpc('reap_expired_leases')
  if (error) return 0
  return typeof data === 'number' ? data : 0
}

/** Keeps a long generation from being reaped out from under the worker. */
export async function heartbeat(jobId: string): Promise<void> {
  await db()
    .from('jobs')
    .update({ lease_expires_at: new Date(Date.now() + 3 * 60_000).toISOString() })
    .eq('id', jobId)
    .eq('status', 'running')
}

export async function countQueued(): Promise<number> {
  const { count } = await db()
    .from('jobs')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'queued')
  return count ?? 0
}
