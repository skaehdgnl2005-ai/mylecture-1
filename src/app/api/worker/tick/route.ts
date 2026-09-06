import { NextResponse, after } from 'next/server'
import { env } from '@/lib/env'
import { tick } from '@/lib/queue/worker'
import { db, logEvent } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Vercel Hobby: 300 is both the default AND the maximum. The old 10s/60s limits
// disappeared when Fluid Compute became the default (2025-04-23).
export const maxDuration = 300

/**
 * The worker.
 *
 * Woken by three redundant pumps, all idempotent because claim_job() is the
 * only gate that matters:
 *   1. Supabase pg_cron every 10s via pg_net  (primary — works with every phone closed)
 *   2. a student's status poll, when a job of theirs is queued
 *   3. the teacher dashboard poll and the "지금 그리기" button
 *
 * THE RESPONSE IS SENT BEFORE THE WORK STARTS, and the drain runs in after().
 * That is not a nicety. Every pump is fire-and-forget with a short client-side
 * timeout so a student's poll is never held up; if the drain ran inside the
 * request, the caller's abort would close the socket and kill the loop after a
 * second or two. The queue would then advance only as fast as pg_cron ticks
 * (once per 10s) instead of as fast as the rate gate allows, silently wasting
 * most of the 300s budget — measured: 20 jobs took 251s at a spacing that
 * should have drained them in ~65s.
 *
 * after() shares the invocation's maxDuration (it is not a durable background
 * job), which is exactly right here: the drain loop already stops at 240s.
 *
 * Pass {"wait": true} to run synchronously and get the summary back — used by
 * the smoke and load-test scripts.
 */
export async function POST(req: Request) {
  if (req.headers.get('x-worker-secret') !== env().WORKER_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as { wait?: boolean; source?: string }

  const holder = crypto.randomUUID()
  const { data: acquired, error } = await db().rpc('try_acquire_tick', {
    p_holder: holder,
    // Self-releases if this invocation is killed at the platform ceiling.
    p_ttl_seconds: 300,
  })

  if (error) {
    // Fail open: a duplicate drain loop is wasteful, never incorrect, because
    // claim_job() holds the rate and concurrency bounds regardless.
    await logEvent('tick_lease_unavailable', { detail: { message: error.message } })
    if (body.wait) return NextResponse.json(await tick())
    after(async () => {
      await tick()
    })
    return NextResponse.json({ accepted: true, lease: 'unavailable' }, { status: 202 })
  }

  if (acquired !== true) {
    return NextResponse.json({ accepted: false, skipped: 'tick already running' }, { status: 200 })
  }

  const release = async () => {
    await db().rpc('release_tick', { p_holder: holder })
  }

  if (body.wait) {
    try {
      return NextResponse.json(await tick())
    } finally {
      await release()
    }
  }

  after(async () => {
    try {
      await tick()
    } catch (e) {
      await logEvent('tick_error', { detail: { message: String(e) } })
    } finally {
      await release()
    }
  })

  return NextResponse.json({ accepted: true }, { status: 202 })
}
