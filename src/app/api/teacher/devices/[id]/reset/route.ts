import { NextResponse } from 'next/server'
import { db, logEvent } from '@/lib/db'
import { requireTeacher } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * "이 기기 횟수 초기화" (PRD §F3) — for the student whose phone died mid-lesson.
 *
 * Sets reset_at rather than deleting rows: used_quota() only counts jobs created
 * after reset_at, so the history stays intact for the teacher's export while the
 * student gets their attempts back.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireTeacher()
  if (denied) return denied
  const { id } = await ctx.params

  const body = (await req.json().catch(() => null)) as { sessionCode?: string } | null
  if (!body?.sessionCode) return NextResponse.json({ ok: false }, { status: 400 })

  const { error } = await db()
    .from('devices')
    .update({ reset_at: new Date().toISOString() })
    .eq('id', id)
    .eq('session_code', body.sessionCode)

  if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
  await logEvent('device_reset', { sessionCode: body.sessionCode })
  return NextResponse.json({ ok: true })
}
