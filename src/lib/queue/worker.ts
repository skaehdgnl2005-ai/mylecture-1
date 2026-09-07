import 'server-only'
import { db, logEvent, type JobRow, type SessionRow } from '@/lib/db'
import { env, spacingMs } from '@/lib/env'
import { claimJob, msUntilSlot, heartbeat, reapExpiredLeases } from './claim'
import { generateImage } from '@/lib/openai/image'
import { classifyImageError, backoffMs } from '@/lib/openai/errors'
import { imageKey, uploadImage } from '@/lib/storage'
import { buildImagePrompt, buildGalleryTags, type PromptInput } from '@/lib/prompt/build-image-prompt'

/**
 * The worker tick.
 *
 * Kept in lib/ rather than inline in the route handler so that the queue can be
 * moved to an always-on process later without touching anything else: it takes
 * a deadline and returns a summary, and knows nothing about Vercel.
 *
 * Vercel Hobby allows 300s per invocation, so we stop at 240s and let the next
 * tick (pg_cron every 10s, or any student poll) pick up where we left off.
 */

export interface TickSummary {
  claimed: number
  done: number
  failed: number
  skipped?: string
  ms: number
}

const SOFT_DEADLINE_MS = 240_000

export interface JobInputs {
  place: PromptInput['place']
  companions: PromptInput['companions']
  mood: PromptInput['mood']
  time: PromptInput['time']
  style: PromptInput['style']
  gender: PromptInput['gender']
}

async function loadSession(code: string): Promise<SessionRow | null> {
  const { data } = await db().from('sessions').select('*').eq('code', code).maybeSingle()
  return (data as SessionRow | null) ?? null
}

async function anyOpenSession(): Promise<SessionRow | null> {
  const { data } = await db()
    .from('sessions')
    .select('*')
    .in('status', ['open', 'draining'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as SessionRow | null) ?? null
}

async function finishOk(
  job: JobRow,
  url: string,
  path: string,
  tags: string[],
  quality: string,
): Promise<void> {
  // raw_text_ko is NULLed here. Once the English clause exists the Korean
  // original has no function, and it is the highest-risk field in the system —
  // it must not also have the longest lifetime.
  //
  // image_quality is written in the SAME statement, and it is the quality this
  // picture was ACTUALLY drawn at — the value passed to generateImage() a few
  // lines up, not whatever the session says by the time the teacher looks. The
  // console sums these per row (migration 0008), so a mid-lesson 화질 change no
  // longer re-prices pictures that are already finished.
  await db()
    .from('jobs')
    .update({
      status: 'done',
      finished_at: new Date().toISOString(),
      lease_expires_at: null,
      raw_text_ko: null,
      image_quality: quality,
    })
    .eq('id', job.id)

  await db().from('images').insert({
    job_id: job.id,
    session_code: job.session_code,
    device_id: job.device_id,
    storage_path: path,
    url,
    tags,
  })

  await logEvent('done', { jobId: job.id, sessionCode: job.session_code })
}

async function finishFail(job: JobRow, code: string, message: string): Promise<void> {
  await db()
    .from('jobs')
    .update({
      status: 'failed',
      error_code: code,
      error_message: message.slice(0, 500),
      finished_at: new Date().toISOString(),
      lease_expires_at: null,
    })
    .eq('id', job.id)
  await logEvent('failed', { jobId: job.id, sessionCode: job.session_code, detail: { code } })
}

async function requeue(job: JobRow, delayMs: number, code: string): Promise<void> {
  await db()
    .from('jobs')
    .update({
      status: 'queued',
      next_attempt_at: new Date(Date.now() + delayMs).toISOString(),
      lease_expires_at: null,
      error_code: code,
    })
    .eq('id', job.id)
  await logEvent('requeued', {
    jobId: job.id,
    sessionCode: job.session_code,
    detail: { code, delayMs, try: job.tries },
  })
}

async function processJob(job: JobRow, session: SessionRow): Promise<'done' | 'failed'> {
  const cfg = env()
  const inputs = job.inputs as unknown as JobInputs
  const hb = setInterval(() => void heartbeat(job.id), 45_000)

  try {
    const prompt =
      job.prompt ??
      buildImagePrompt({
        actionEn: job.action_en ?? '',
        visibleDetailEn: job.visible_detail_en,
        place: inputs.place,
        companions: inputs.companions,
        mood: inputs.mood,
        time: inputs.time,
        style: inputs.style,
        gender: inputs.gender,
        attempt: job.attempt_no,
      })

    if (!job.prompt) {
      await db().from('jobs').update({ prompt }).eq('id', job.id)
    }

    // Read once and reuse: the same value goes to the API and onto the row, so
    // the recorded quality cannot disagree with the picture that was billed.
    const quality = session.image_quality
    const image = await generateImage(prompt, { quality })
    const key = imageKey(job.session_code, image.extension)
    const { url, path } = await uploadImage(key, image.bytes, image.contentType)
    await finishOk(job, url, path, buildGalleryTags(inputs), quality)
    return 'done'
  } catch (err) {
    const f = classifyImageError(err)
    const exhausted = job.tries >= cfg.MAX_TRIES

    if (!f.retryable || exhausted) {
      await finishFail(job, f.kind, f.message)
      return 'failed'
    }
    // The retry re-enters claim_job()'s gate; this only sets the earliest time
    // it becomes claimable. Unsuccessful requests count against the per-minute
    // limit, so a retry that skipped the gate would guarantee a 429 cascade.
    await requeue(job, backoffMs(job.tries, spacingMs(session.per_minute_limit), f.retryAfterSec), f.kind)
    return 'failed'
  } finally {
    clearInterval(hb)
  }
}

export async function tick(now = Date.now()): Promise<TickSummary> {
  const started = now
  const summary: TickSummary = { claimed: 0, done: 0, failed: 0, ms: 0 }

  await reapExpiredLeases()

  const session = await anyOpenSession()
  if (!session) {
    summary.skipped = 'no active session'
    summary.ms = Date.now() - started
    return summary
  }

  const inFlight = new Set<Promise<void>>()

  while (Date.now() - started < SOFT_DEADLINE_MS) {
    const job = await claimJob(session)

    if (!job) {
      // Nothing claimable: either the queue is empty or the slot has not opened.
      const { count } = await db()
        .from('jobs')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'queued')
        .eq('session_code', session.code)

      if (!count) break

      const wait = Math.min(await msUntilSlot() || 1000, SOFT_DEADLINE_MS - (Date.now() - started))
      if (wait <= 0) break
      await new Promise((r) => setTimeout(r, Math.max(250, wait)))
      continue
    }

    summary.claimed++
    // Reload the session each claim so a mid-lesson settings change (quality,
    // per-minute cap, queue order) takes effect without a redeploy.
    const fresh = (await loadSession(session.code)) ?? session

    const p = processJob(job, fresh)
      .then((r) => {
        if (r === 'done') summary.done++
        else summary.failed++
      })
      .catch(async (e) => {
        summary.failed++
        await finishFail(job, 'worker_error', String(e))
      })
      .finally(() => inFlight.delete(p))
    inFlight.add(p)

    // Bound in-flight work so the tick can always drain before its deadline.
    while (inFlight.size >= env().MAX_IN_FLIGHT) {
      await Promise.race(inFlight)
    }
  }

  await Promise.allSettled([...inFlight])

  // A draining session is one the teacher has closed: no new submissions are
  // accepted (POST /api/jobs requires status 'open'), but the pictures already
  // waiting still get drawn. Once none are left it becomes 'closed' for real.
  //
  // This lives here rather than on the teacher's screen because it must happen
  // whether or not that laptop is still open — the last student's picture is
  // usually still in flight when the teacher shuts the lid.
  //
  // The status is re-read rather than taken from `session`: a tick that began
  // while the lesson was still open is usually the very tick that drains the
  // last picture, and the teacher pressed 수업 닫기 somewhere in the middle of it.
  const current = (await loadSession(session.code)) ?? session
  if (current.status === 'draining') {
    const { count: left } = await db()
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('session_code', session.code)
      .in('status', ['queued', 'running'])

    if (!left) {
      await db()
        .from('sessions')
        .update({ status: 'closed', closed_at: new Date().toISOString() })
        .eq('code', session.code)
        .eq('status', 'draining')
      await logEvent('session_drained', { sessionCode: session.code })
    }
  }

  summary.ms = Date.now() - started
  return summary
}
