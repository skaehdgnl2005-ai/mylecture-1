import { NextResponse } from 'next/server'
import { db, logEvent } from '@/lib/db'
import { requireTeacher } from '@/lib/auth'
import { reapExpiredLeases } from '@/lib/queue/claim'
import { env } from '@/lib/env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Break-glass panel.
 *
 * Reads jobs_public, never `jobs`, so the student's Korean sentence cannot
 * appear on a laptop screen a student might walk past. The teacher sees the
 * ENGLISH clause instead: already stripped of names and brands by the
 * translator, and a genuine practical privacy buffer in a Korean classroom.
 */
export async function GET(req: Request) {
  const denied = await requireTeacher()
  if (denied) return denied

  const code = new URL(req.url).searchParams.get('code')
  let q = db()
    .from('jobs_public')
    .select('id, session_code, device_id, attempt_no, status, tries, error_code, error_message, created_at, finished_at, action_en')
    .order('created_at', { ascending: false })
    .limit(200)
  if (code) q = q.eq('session_code', code)

  const { data: jobs } = await q

  const { data: devices } = code
    ? await db().from('devices').select('id, label, reset_at').eq('session_code', code)
    : { data: [] }

  const labels = Object.fromEntries((devices ?? []).map((d) => [d.id, d.label]))

  // pg_net is fire-and-forget, so a green cron run is NOT evidence the worker
  // ran. The only real signal is the HTTP response table, kept 6 hours.
  let pump: unknown = null
  try {
    const { data } = await db().rpc('cron_health')
    pump = data
  } catch {
    pump = { scheduled: false, last_response: null }
  }

  return NextResponse.json({
    jobs: (jobs ?? []).map((j) => ({ ...j, deviceLabel: labels[j.device_id] ?? '알 수 없음' })),
    pump,
    config: { ipm: env().OPENAI_IPM, maxInFlight: env().MAX_IN_FLIGHT },
  })
}

/** Retry one job, reclaim dead leases, or force a worker tick. */
export async function POST(req: Request) {
  const denied = await requireTeacher()
  if (denied) return denied

  const body = (await req.json().catch(() => null)) as
    | { action: 'retry' | 'reap' | 'tick'; jobId?: string }
    | null
  if (!body?.action) return NextResponse.json({ ok: false }, { status: 400 })

  if (body.action === 'retry' && body.jobId) {
    // tries is reset so a retried job gets a full budget again; the attempt was
    // never charged to the student either way.
    const { error } = await db()
      .from('jobs')
      .update({
        status: 'queued',
        tries: 0,
        error_code: null,
        error_message: null,
        finished_at: null,
        lease_expires_at: null,
        next_attempt_at: new Date().toISOString(),
        deadline_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      })
      .eq('id', body.jobId)
    if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
    await logEvent('teacher_retry', { jobId: body.jobId })
  }

  if (body.action === 'reap') {
    const n = await reapExpiredLeases()
    await logEvent('teacher_reap', { detail: { reaped: n } })
  }

  // Wake the worker directly — the button that gets a stalled queue moving
  // when pg_cron is not running.
  const base = env().APP_URL
  if (base) {
    void fetch(`${base}/api/worker/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-secret': env().WORKER_SECRET },
      body: JSON.stringify({ source: 'teacher' }),
      signal: AbortSignal.timeout(1500),
    }).catch(() => {})
  }

  return NextResponse.json({ ok: true })
}
