import { NextResponse } from 'next/server'
import { db, type SessionRow } from '@/lib/db'
import { env, etaSeconds } from '@/lib/env'
import { queuePosition } from '@/lib/queue/claim'
import { kickWorker } from '@/lib/pump'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Student-facing Korean for each terminal failure. No technical terms. */
const FAIL_COPY: Record<string, string> = {
  moderation_input: '그림으로 그리기 어려운 내용이에요. 1번 문장을 조금 바꿔볼까요?',
  moderation_output: '그림이 잘 안 나왔어요. 다시 한 번 그려볼까요?',
  rate_limit: '지금 친구들이 많이 그리고 있어요. 잠시 뒤 다시 해볼까요?',
  billing: '지금은 그림을 그릴 수 없어요. 선생님께 알려 주세요.',
  transient: '잠깐 문제가 생겼어요. 다시 한 번 해볼까요?',
  bad_request: '다시 한 번 해볼까요?',
  lease_expired: '그리다가 멈췄어요. 다시 한 번 해볼까요?',
  worker_error: '잠깐 문제가 생겼어요. 다시 한 번 해볼까요?',
  // Set by the sweep in reap_expired_leases(): the job waited past its deadline
  // without ever being claimed. The attempt was NOT charged, so this is an
  // invitation to try again, not a dead end.
  deadline_exceeded: '너무 오래 기다렸어요. 다시 한 번 해볼까요?',
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // Next 16: params is a Promise and synchronous access is a hard error.
  const { id } = await ctx.params
  const deviceId = new URL(req.url).searchParams.get('deviceId')

  // Read the view, never the table: raw_text_ko is not in it, so a mistake here
  // cannot leak the student's sentence.
  const { data: job } = await db()
    .from('jobs_public')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (!job) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // Anyone with a job id could otherwise poll anyone's job.
  if (deviceId && job.device_id !== deviceId) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  if (job.status === 'done') {
    const { data: image } = await db()
      .from('images')
      .select('id, url, tags, in_gallery')
      .eq('job_id', id)
      .maybeSingle()
    return NextResponse.json({
      status: 'done',
      imageId: image?.id ?? null,
      imageUrl: image?.url ?? null,
      tags: image?.tags ?? [],
      inGallery: image?.in_gallery ?? true,
    })
  }

  if (job.status === 'failed') {
    return NextResponse.json({
      status: 'failed',
      errorCode: job.error_code,
      // The attempt was never consumed — used_quota excludes failed rows.
      message: FAIL_COPY[job.error_code ?? ''] ?? FAIL_COPY.transient,
      quotaCharged: false,
    })
  }

  const { data: s } = await db()
    .from('sessions')
    .select('queue_order, per_minute_limit')
    .eq('code', job.session_code)
    .maybeSingle()
  const session = s as Pick<SessionRow, 'queue_order' | 'per_minute_limit'> | null

  const position =
    job.status === 'queued'
      ? await queuePosition(id, session?.queue_order ?? env().QUEUE_ORDER)
      : 0

  // Secondary pump. Twenty phones polling every 2.5s is ~8Hz of free liveness,
  // so the queue keeps moving even if pg_cron is not running at all.
  if (job.status === 'queued') kickWorker()

  return NextResponse.json({
    status: job.status,
    position,
    etaSec: etaSeconds(
      position || 1,
      Math.min(session?.per_minute_limit ?? env().OPENAI_IPM, env().OPENAI_IPM),
    ),
    pollIntervalMs: env().POLL_INTERVAL_MS,
  })
}
