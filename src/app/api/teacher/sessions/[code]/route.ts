import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db, logEvent } from '@/lib/db'
import { requireTeacher } from '@/lib/auth'
import { env } from '@/lib/env'
import { deleteImages } from '@/lib/storage'
import { kickWorker } from '@/lib/pump'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const Patch = z.object({
  status: z.enum(['open', 'draining', 'closed']).optional(),
  perDeviceLimit: z.number().int().min(1).max(10).optional(),
  totalLimit: z.number().int().min(1).max(500).optional(),
  perMinuteLimit: z.number().int().min(1).max(250).optional(),
  allowedStyles: z.array(z.enum(['anime', 'photo', 'watercolor'])).min(1).optional(),
  imageQuality: z.enum(['low', 'medium', 'high']).optional(),
  queueOrder: z.enum(['fifo', 'attempt_priority']).optional(),
})

export async function PATCH(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const denied = await requireTeacher()
  if (denied) return denied
  const { code } = await ctx.params

  const parsed = Patch.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ ok: false }, { status: 400 })
  const p = parsed.data

  const patch: Record<string, unknown> = {}
  if (p.status) {
    patch.status = p.status
    if (p.status === 'closed') patch.closed_at = new Date().toISOString()
  }
  if (p.perDeviceLimit !== undefined) patch.per_device_limit = p.perDeviceLimit
  if (p.totalLimit !== undefined) patch.total_limit = p.totalLimit
  if (p.perMinuteLimit !== undefined) {
    // CLAMPED to the account's real ceiling. A well-meaning teacher must not be
    // able to turn a working lesson into a 429 storm: OpenAI counts failed
    // requests against the limit too, so overshooting makes things slower, not
    // faster.
    patch.per_minute_limit = Math.min(p.perMinuteLimit, env().OPENAI_IPM)
  }
  if (p.allowedStyles) patch.allowed_styles = p.allowedStyles
  if (p.imageQuality) patch.image_quality = p.imageQuality
  if (p.queueOrder) patch.queue_order = p.queueOrder

  const { data, error } = await db()
    .from('sessions')
    .update(patch)
    .eq('code', code)
    .select()
    .single()

  if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
  await logEvent('session_updated', { sessionCode: code, detail: patch })

  // 수업 닫기 asks for 'draining' so pictures already queued still get drawn.
  // When there is nothing left to draw — the usual case, the teacher closes
  // after the last picture lands — draining would be a state nobody ever leaves
  // in front of the teacher, so finish the job here.
  let session = data
  if (p.status === 'draining') {
    const { count: pending } = await db()
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('session_code', code)
      .in('status', ['queued', 'running'])

    if (!pending) {
      const { data: closed } = await db()
        .from('sessions')
        .update({ status: 'closed', closed_at: new Date().toISOString() })
        .eq('code', code)
        .eq('status', 'draining')
        .select()
        .single()
      if (closed) session = closed
    } else {
      kickWorker()
    }
  }

  return NextResponse.json({
    ok: true,
    session,
    clampedIpm: p.perMinuteLimit !== undefined && p.perMinuteLimit > env().OPENAI_IPM,
  })
}

/**
 * Delete a session and everything in it (PRD §6-4: no auto-deletion, the
 * teacher decides). Storage objects go FIRST so a failure leaves a recoverable
 * pointer rather than an orphaned blob nobody can find.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const denied = await requireTeacher()
  if (denied) return denied
  const { code } = await ctx.params

  // Two-step confirmation is enforced by the client, but the server requires
  // the code to be echoed back so a stray DELETE cannot wipe a session.
  const body = (await req.json().catch(() => null)) as { confirm?: string } | null
  if (body?.confirm !== code) {
    return NextResponse.json({ ok: false, message: '세션 코드를 확인해 주세요.' }, { status: 400 })
  }

  const { data: images } = await db()
    .from('images')
    .select('storage_path')
    .eq('session_code', code)

  const paths = (images ?? []).map((i) => i.storage_path)
  if (paths.length > 0) {
    try {
      await deleteImages(paths)
    } catch (e) {
      return NextResponse.json(
        { ok: false, message: `그림 파일을 지우지 못했어요: ${(e as Error).message}` },
        { status: 500 },
      )
    }
  }

  // devices/jobs/images cascade from sessions.
  const { error } = await db().from('sessions').delete().eq('code', code)
  if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 })

  await logEvent('session_deleted', { sessionCode: code, detail: { images: paths.length } })
  return NextResponse.json({ ok: true, deletedImages: paths.length })
}
