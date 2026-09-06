import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db, logEvent, type SessionRow } from '@/lib/db'
import { runSafetyPipeline, fallbackAction } from '@/lib/safety/pipeline'
import { reserveAttempt, sessionUsage } from '@/lib/quota'
import { kickWorker } from '@/lib/pump'
import {
  PLACE_IDS, COMPANION_IDS, MOOD_IDS, TIME_IDS, STYLE_IDS, GENDER_IDS,
} from '@/lib/prompt/build-image-prompt'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Moderation + two translation calls. Nowhere near the ceiling, but not instant.
export const maxDuration = 60

const Body = z.object({
  code: z.string().regex(/^[A-Za-z0-9]{4}$/),
  deviceId: z.string().uuid(),
  // Minted once when the student reaches step 5 and reused until the attempt
  // resolves. This is what makes one tap one job.
  idempotencyKey: z.string().min(8).max(64),
  rawText: z.string().min(1).max(40),
  visibleDetail: z.string().max(15).default(''),
  place: z.enum(PLACE_IDS as [string, ...string[]]),
  companions: z.array(z.enum(COMPANION_IDS as [string, ...string[]])).min(1).max(2),
  mood: z.enum(MOOD_IDS as [string, ...string[]]),
  time: z.enum(TIME_IDS as [string, ...string[]]),
  style: z.enum(STYLE_IDS as [string, ...string[]]),
  gender: z.enum(GENDER_IDS as [string, ...string[]]).default('unspecified'),
})

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, message: '답변을 다시 확인해 주세요.' },
      { status: 400 },
    )
  }
  const b = parsed.data
  const code = b.code.toUpperCase()

  const { data } = await db().from('sessions').select('*').eq('code', code).maybeSingle()
  const session = data as SessionRow | null
  if (!session || session.status !== 'open') {
    return NextResponse.json(
      { ok: false, message: '지금은 그림을 그릴 수 없어요.' },
      { status: 409 },
    )
  }

  // Cheap refusals BEFORE the paid pipeline: no point translating a submission
  // we are about to refuse for quota.
  const usage = await sessionUsage(session, b.deviceId)
  if (usage.remaining <= 0) {
    return NextResponse.json(
      { ok: false, reason: 'quota', message: '그림을 모두 그렸어요. 친구들 그림을 구경해 볼까요?' },
      { status: 429 },
    )
  }
  if (usage.sessionRemaining <= 0) {
    return NextResponse.json(
      { ok: false, reason: 'session_cap', message: '오늘 그림은 모두 그렸어요.' },
      { status: 429 },
    )
  }

  // ── Safety layers 1-3, per field, BEFORE any job row exists ──────────────
  const safety = await runSafetyPipeline({
    rawText: b.rawText,
    visibleDetail: b.visibleDetail,
    place: b.place as never,
  })

  if (!safety.ok) {
    await logEvent('rejected', {
      sessionCode: code,
      detail: { kind: safety.kind, field: safety.field },
    })
    // 200, not an error status: this is a normal conversational outcome and the
    // student's attempt is untouched — no job row was ever created.
    return NextResponse.json({
      ok: false,
      reason: safety.kind,
      field: safety.field,
      message: safety.message,
      helpline: safety.helpline ?? false,
      quotaCharged: false,
    })
  }

  const actionEn = safety.actionEn || fallbackAction(b.place as never)

  const reserved = await reserveAttempt({
    sessionCode: code,
    deviceId: b.deviceId,
    idempotencyKey: b.idempotencyKey,
    inputs: {
      place: b.place, companions: b.companions, mood: b.mood,
      time: b.time, style: b.style, gender: b.gender,
    },
    rawTextKo: b.rawText,
    actionEn,
    visibleDetailEn: safety.visibleDetailEn,
  })

  if (!reserved.ok) {
    // A duplicate is the double-tap case: hand back the job that already exists
    // so the student lands on the waiting screen instead of an error.
    if (reserved.reason === 'duplicate' && reserved.jobId) {
      return NextResponse.json({ ok: true, jobId: reserved.jobId, duplicate: true })
    }
    const message =
      reserved.reason === 'session_cap'
        ? '오늘 그림은 모두 그렸어요.'
        : reserved.reason === 'quota'
          ? '그림을 모두 그렸어요. 친구들 그림을 구경해 볼까요?'
          : '지금은 그림을 그릴 수 없어요.'
    return NextResponse.json({ ok: false, reason: reserved.reason, message }, { status: 429 })
  }

  kickWorker()

  return NextResponse.json(
    { ok: true, jobId: reserved.jobId, attemptNo: reserved.attemptNo },
    { status: 201 },
  )
}
