import 'server-only'
import { env } from './env'

/**
 * Secondary pump.
 *
 * pg_cron is the primary heartbeat, but it lives in a different system and can
 * be paused, unscheduled, or blocked by a Supabase project pause. Student and
 * teacher polls therefore also nudge the worker. Every path funnels through
 * claim_job(), so an extra tick is wasteful at worst, never incorrect — and the
 * tick lease makes even the waste small.
 *
 * Deliberately fire-and-forget: the poll response must not wait on it.
 *
 * The 1.5s timeout only releases THIS request. It is safe because the worker
 * route replies 202 immediately and does its draining in after(), so aborting
 * here cannot cut the drain short. (It could, before — the worker used to run
 * inside the request, and this abort was silently capping every tick at ~1.5s.)
 */
export function kickWorker(): void {
  const base = env().APP_URL
  if (!base) return
  void fetch(`${base}/api/worker/tick`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-worker-secret': env().WORKER_SECRET,
    },
    body: JSON.stringify({ source: 'poll' }),
    // Never let a slow worker hold up a student's status poll.
    signal: AbortSignal.timeout(1500),
  }).catch(() => {
    // Expected: the request is abandoned as soon as the worker starts working.
  })
}
