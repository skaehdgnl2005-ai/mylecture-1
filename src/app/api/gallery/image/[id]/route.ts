import { NextResponse } from 'next/server'
import { db, logEvent } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * A student takes their OWN picture down, and puts it back (PRD §F2).
 * Ownership is the device UUID; there is no other identity in the system.
 * Neither verb touches the file — the image stays in the teacher's ZIP export.
 */

/**
 * The shared ownership guard, so the two verbs cannot drift apart.
 *
 * Same 404 whether the image is missing or someone else's: no probing.
 *
 * `requireVisible` is the ONE asymmetry, and it only applies to PUT. Taking your
 * own picture down is always allowed — a teacher-hidden picture is already out
 * of the gallery, so `in_gallery = false` is a harmless no-op, and refusing it
 * would turn the student's switch into a dead control. Putting one BACK is not:
 * if the teacher has hidden it, `in_gallery = true` would not return it to the
 * gallery, so a 200 there would be a lie.
 */
async function ownedImage(id: string, deviceId: string, requireVisible = false) {
  const { data } = await db()
    .from('images')
    .select('id, device_id, session_code, is_hidden')
    .eq('id', id)
    .maybeSingle()

  if (!data || data.device_id !== deviceId) return null
  if (requireVisible && data.is_hidden) return null
  return data
}

async function deviceIdFrom(req: Request): Promise<string | null> {
  const body = (await req.json().catch(() => null)) as { deviceId?: string } | null
  return body?.deviceId ?? null
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const deviceId = await deviceIdFrom(req)
  if (!deviceId) return NextResponse.json({ error: 'deviceId required' }, { status: 400 })

  const image = await ownedImage(id, deviceId)
  if (!image) return NextResponse.json({ error: 'not found' }, { status: 404 })

  await db().from('images').update({ in_gallery: false }).eq('id', id)
  await logEvent('student_removed', { sessionCode: image.session_code })
  return NextResponse.json({ ok: true })
}

/**
 * The exact inverse of DELETE, and the reason it exists: the result screen's
 * "친구들과 함께 보기" switch could turn OFF but had no way to turn back ON, so
 * flipping it back changed the UI and nothing else.
 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const deviceId = await deviceIdFrom(req)
  if (!deviceId) return NextResponse.json({ error: 'deviceId required' }, { status: 400 })

  // requireVisible: a student must never be able to undo a teacher's 숨기기.
  const image = await ownedImage(id, deviceId, true)
  if (!image) return NextResponse.json({ error: 'not found' }, { status: 404 })

  await db().from('images').update({ in_gallery: true }).eq('id', id)
  await logEvent('student_restored', { sessionCode: image.session_code })
  return NextResponse.json({ ok: true })
}
