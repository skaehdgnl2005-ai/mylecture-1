import { NextResponse } from 'next/server'
import { db, logEvent } from '@/lib/db'
import { requireTeacher } from '@/lib/auth'
import { reapExpiredLeases } from '@/lib/queue/claim'
import { env } from '@/lib/env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Codes of lessons that are over.
 *
 * 'closed' ONLY — never 'open' and never 'draining'. Draining is a lesson the
 * teacher just closed whose queue is still being drawn (see the worker), so it
 * holds exactly the pictures that must not be thrown away. This one filter is
 * what makes 정리 safe to press in the middle of a lesson.
 */
async function closedSessionCodes(): Promise<string[]> {
  const { data } = await db().from('sessions').select('code').eq('status', 'closed')
  return (data ?? []).map((s) => s.code as string)
}

/** How many jobs 정리 would clear right now. */
async function countClosedLeftovers(): Promise<number> {
  const codes = await closedSessionCodes()
  if (codes.length === 0) return 0
  const { count } = await db()
    .from('jobs')
    .select('id', { count: 'exact', head: true })
    .in('session_code', codes)
    .in('status', ['queued', 'running'])
  return count ?? 0
}

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

  // Labels are looked up for whatever sessions the returned jobs actually belong
  // to, not just for an explicit ?code=. QueuePanel deliberately shows every
  // session's jobs (leftovers from a previous lesson are the whole point of the
  // screen), and asking for one code left every row reading '알 수 없음' — which
  // is exactly the column a teacher opens this panel to read.
  const codes = [...new Set((jobs ?? []).map((j) => j.session_code))]
  const { data: devices } = codes.length
    ? await db().from('devices').select('id, label, reset_at').in('session_code', codes)
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
    // Drives the 정리 button's label and its disabled state. Without a count the
    // teacher presses it, nothing on screen moves, and they cannot tell whether
    // it worked or there was nothing to do.
    closedLeftovers: await countClosedLeftovers(),
    config: { ipm: env().OPENAI_IPM, maxInFlight: env().MAX_IN_FLIGHT },
  })
}

/** Retry one job, reclaim dead leases, sweep old lessons, or force a tick. */
export async function POST(req: Request) {
  const denied = await requireTeacher()
  if (denied) return denied

  const body = (await req.json().catch(() => null)) as
    | { action: 'retry' | 'reap' | 'tick' | 'sweep'; jobId?: string }
    | null
  if (!body?.action) return NextResponse.json({ ok: false }, { status: 400 })

  /**
   * 정리 — the button 수업 전 점검's red 대기열 row has been telling teachers to
   * press since before it existed ("교사 화면 > 대기열에서 정리할 수 있어요").
   *
   * SCOPED BY SESSION STATUS, NOT BY AGE. reap_expired_leases() already fails
   * anything past its 15-minute deadline_at, which covers most leftovers — but
   * only most: a job the teacher retried just before closing the lesson carries
   * a fresh deadline and sits there, counted by the preflight check, for another
   * quarter of an hour. More importantly reap is global, so it can only ever be
   * "wait for the timeout". This asks a different question — is the lesson these
   * jobs belong to over? — which is the one a teacher can answer at 8:50am, and
   * the one that makes the answer safe while a class is running.
   *
   * queued AND running: the preflight check counts both, so clearing only half
   * of them would leave the row red and the button looking broken. A 'running'
   * row on a closed lesson has no worker behind it either way — tick() only
   * looks at open and draining sessions.
   *
   * Rows go to 'failed', never deleted: used_quota() excludes 'failed', so the
   * students get their attempts back, the job_events trail survives, and this
   * lands on exactly the path 'deadline_exceeded' already uses.
   */
  if (body.action === 'sweep') {
    const codes = await closedSessionCodes()
    if (codes.length === 0) return NextResponse.json({ ok: true, swept: 0 })

    const { data: swept, error } = await db()
      .from('jobs')
      .update({
        status: 'failed',
        error_code: 'swept',
        error_message: '지난 수업의 잔여 작업',
        finished_at: new Date().toISOString(),
        lease_expires_at: null,
      })
      .in('session_code', codes)
      .in('status', ['queued', 'running'])
      .select('id')

    if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
    const n = swept?.length ?? 0
    await logEvent('teacher_sweep', { detail: { swept: n, sessions: codes.length } })
    return NextResponse.json({ ok: true, swept: n })
  }

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
