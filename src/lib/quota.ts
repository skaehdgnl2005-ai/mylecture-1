import 'server-only'
import { db, type SessionRow } from './db'
import { usedQuota } from './queue/claim'

/**
 * Quota and session-cap enforcement.
 *
 * Two guards are needed because they stop DIFFERENT races:
 *
 *   1. the unique index on (session_code, device_id, idempotency_key)
 *      stops ONE tap becoming TWO jobs (double-tap, retried fetch, flaky wifi).
 *   2. the `reserve_attempt` transaction below stops TWO different taps from
 *      both passing the cap check before either has inserted.
 *
 * Neither alone is sufficient.
 *
 * LOCK ORDER IS ALWAYS sessions -> devices. Reversing it anywhere deadlocks 20
 * simultaneous taps at the cap, which is exactly the load this is built for.
 * That ordering lives in one SQL function and nowhere else.
 */

export type ReserveResult =
  | { ok: true; attemptNo: number; jobId: string }
  | { ok: false; reason: 'quota' | 'session_cap' | 'closed' | 'duplicate'; jobId?: string }

export interface ReserveArgs {
  sessionCode: string
  deviceId: string
  idempotencyKey: string
  inputs: Record<string, unknown>
  rawTextKo: string
  actionEn: string
  visibleDetailEn: string | null
}

export async function reserveAttempt(args: ReserveArgs): Promise<ReserveResult> {
  const { data, error } = await db().rpc('reserve_attempt', {
    p_session: args.sessionCode,
    p_device: args.deviceId,
    p_idem: args.idempotencyKey,
    p_inputs: args.inputs,
    p_raw_text: args.rawTextKo,
    p_action_en: args.actionEn,
    p_detail_en: args.visibleDetailEn,
  })
  if (error) throw new Error(`reserve_attempt failed: ${error.message}`)

  const row = (Array.isArray(data) ? data[0] : data) as
    | { ok: boolean; reason: string | null; attempt_no: number | null; job_id: string | null }
    | null
  if (!row) return { ok: false, reason: 'closed' }

  if (row.ok) {
    return { ok: true, attemptNo: row.attempt_no ?? 1, jobId: row.job_id! }
  }
  return {
    ok: false,
    reason: (row.reason as ReserveResult extends { ok: false; reason: infer R } ? R : never) ?? 'closed',
    jobId: row.job_id ?? undefined,
  }
}

export async function sessionUsage(session: SessionRow, deviceId: string) {
  const [used, { count: total }] = await Promise.all([
    usedQuota(session.code, deviceId),
    db()
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('session_code', session.code)
      .in('status', ['queued', 'running', 'done']),
  ])
  return {
    used,
    remaining: Math.max(0, session.per_device_limit - used),
    sessionTotal: total ?? 0,
    sessionRemaining: Math.max(0, session.total_limit - (total ?? 0)),
  }
}
