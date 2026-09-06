import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireTeacher } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The teacher's image list, including hidden ones (unlike the student gallery).
 *
 * Carries the anonymous device LABEL ('파란 여우') rather than the UUID, and
 * never the student's Korean sentence — see the queue route for why the teacher
 * screen shows the English clause instead.
 */
export async function GET(req: Request) {
  const denied = await requireTeacher()
  if (denied) return denied

  const code = new URL(req.url).searchParams.get('code')
  if (!code) return NextResponse.json({ error: 'code required' }, { status: 400 })

  const [{ data: images }, { data: devices }] = await Promise.all([
    db()
      .from('images')
      .select('id, url, tags, is_hidden, device_id, created_at')
      .eq('session_code', code)
      .order('created_at', { ascending: false }),
    db().from('devices').select('id, label, reset_at').eq('session_code', code),
  ])

  const labels = Object.fromEntries((devices ?? []).map((d) => [d.id, d.label]))

  // Per-device counts for the "이 기기 횟수 초기화" flow (PRD §F3).
  const counts: Record<string, number> = {}
  for (const img of images ?? []) counts[img.device_id] = (counts[img.device_id] ?? 0) + 1

  return NextResponse.json({
    images: (images ?? []).map((i) => ({ ...i, deviceLabel: labels[i.device_id] ?? '알 수 없음' })),
    devices: (devices ?? []).map((d) => ({
      id: d.id,
      label: d.label,
      count: counts[d.id] ?? 0,
      resetAt: d.reset_at,
    })),
  })
}
