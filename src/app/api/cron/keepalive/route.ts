import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Daily keep-alive. Wired to Vercel Cron in vercel.json.
 *
 * WHY THIS EXISTS: Supabase pauses a Free project after ~7 days of low activity,
 * and this app is used roughly monthly — so "paused" would be the NORMAL state
 * thirty seconds before twenty students scan a QR code. Recovery is a manual
 * dashboard click plus a few minutes, which is not survivable mid-lesson.
 *
 * pg_cron cannot save itself here: it stops the moment the project pauses, and
 * Supabase judges activity on USER requests. The ping must come from outside the
 * project, which is exactly what a Vercel cron hitting this route is. Daily is
 * the most Hobby allows, and Supabase's documented bar is "a few user requests
 * to the database each day", so this clears it.
 *
 * It also unarchives the Vercel function itself (archived after two weeks idle).
 *
 * This is a mitigation for a documented-but-inferred rule. Watch the project
 * for a fortnight before the first real class rather than trusting it blind.
 */
export async function GET(req: Request) {
  // Vercel signs its cron invocations; also allow the worker secret for manual runs.
  const auth = req.headers.get('authorization')
  const isVercelCron = auth === `Bearer ${process.env.CRON_SECRET}` && !!process.env.CRON_SECRET
  const isManual = req.headers.get('x-worker-secret') === process.env.WORKER_SECRET
  if (!isVercelCron && !isManual) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  // A real query against a real table — not a no-op health endpoint.
  const { count, error } = await db()
    .from('sessions')
    .select('code', { count: 'exact', head: true })

  return NextResponse.json({
    ok: !error,
    sessions: count ?? 0,
    ms: Date.now() - started,
    error: error?.message,
  })
}
