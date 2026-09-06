import { NextResponse } from 'next/server'
import { db, logEvent } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * A student takes their OWN picture down (PRD §F2).
 * Ownership is the device UUID; there is no other identity in the system.
 * This only clears in_gallery — the image stays in the teacher's ZIP export.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const body = (await req.json().catch(() => null)) as { deviceId?: string } | null
  if (!body?.deviceId) {
    return NextResponse.json({ error: 'deviceId required' }, { status: 400 })
  }

  const { data: image } = await db()
    .from('images')
    .select('id, device_id, session_code')
    .eq('id', id)
    .maybeSingle()

  // Same 404 whether it is missing or someone else's: no probing.
  if (!image || image.device_id !== body.deviceId) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  await db().from('images').update({ in_gallery: false }).eq('id', id)
  await logEvent('student_removed', { sessionCode: image.session_code })
  return NextResponse.json({ ok: true })
}
