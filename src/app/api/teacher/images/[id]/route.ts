import { NextResponse } from 'next/server'
import { db, logEvent } from '@/lib/db'
import { requireTeacher } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Hide / restore (PRD §F4, §9: gone from the gallery within 5 seconds).
 *
 * The gallery polls every 5s with an ETag whose value includes the row count,
 * so a hide changes the ETag and the next poll repaints — which is what makes
 * the 5-second requirement hold.
 *
 * NOTE (deliberate, see the plan's open risks): this removes the image from the
 * gallery but does NOT revoke its storage URL for anyone who already has it.
 * Keys are unguessable, which is the minimum defensible posture here. Real
 * revocation needs a private bucket and short-TTL signed URLs.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireTeacher()
  if (denied) return denied
  const { id } = await ctx.params

  const body = (await req.json().catch(() => null)) as { isHidden?: boolean } | null
  if (typeof body?.isHidden !== 'boolean') {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  const { data, error } = await db()
    .from('images')
    .update({ is_hidden: body.isHidden })
    .eq('id', id)
    .select('id, session_code')
    .single()

  if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
  await logEvent(body.isHidden ? 'teacher_hid' : 'teacher_restored', { sessionCode: data.session_code })
  return NextResponse.json({ ok: true })
}
