import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { tick } from '@/lib/queue/worker'
import { db } from '@/lib/db'

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
 *   2. a student's status poll, when the queue looks stalled
 *   3. the teacher dashboard poll
 *
 * The tick lease keeps one drain loop running at a time. It is an optimisation:
 * even if it failed open, claim_job() would still hold the rate and concurrency
 * bounds exactly.
 */
export async function POST(req: Request) {
  if (req.headers.get('x-worker-secret') !== env().WORKER_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const holder = crypto.randomUUID()
  const { data: acquired, error } = await db().rpc('try_acquire_tick', {
    p_holder: holder,
    // Self-releases if this invocation is killed at the platform ceiling.
    p_ttl_seconds: 300,
  })

  if (error) {
    // Fail open. A duplicate drain loop is wasteful, not incorrect.
    return NextResponse.json({ ...(await tick()), note: 'tick lease unavailable' })
  }
  if (acquired !== true) {
    return NextResponse.json({ claimed: 0, done: 0, failed: 0, skipped: 'tick already running', ms: 0 })
  }

  try {
    return NextResponse.json(await tick())
  } finally {
    await db().rpc('release_tick', { p_holder: holder })
  }
}
