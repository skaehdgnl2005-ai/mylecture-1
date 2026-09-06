import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireTeacher } from '@/lib/auth'
import { foldDeviceUsage } from '@/lib/device-usage'

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

  const [{ data: images }, { data: devices }, { data: jobs }] = await Promise.all([
    db()
      .from('images')
      // in_gallery is here so the teacher can tell "I hid this" apart from "the
      // student took this down themselves" — two different states that both make
      // a picture vanish from the wall, and only one of which 다시 보이기 fixes.
      .select('id, url, tags, is_hidden, in_gallery, device_id, created_at')
      .eq('session_code', code)
      .order('created_at', { ascending: false }),
    db().from('devices').select('id, label, reset_at').eq('session_code', code),
    // Quota is a derived COUNT over jobs — there is no devices.generation_count
    // (0001_schema.sql says why). One select for the whole session, folded in
    // TypeScript, rather than one used_quota() RPC per device on a 4-second
    // poll. Reads `jobs` and not `jobs_public` because the view does not carry
    // lease_expires_at; the column list is explicit and excludes raw_text_ko,
    // which is the leak the view exists to prevent.
    db()
      .from('jobs')
      .select('device_id, status, created_at, lease_expires_at')
      .eq('session_code', code),
  ])

  const labels = Object.fromEntries((devices ?? []).map((d) => [d.id, d.label]))

  return NextResponse.json({
    images: (images ?? []).map((i) => ({ ...i, deviceLabel: labels[i.device_id] ?? '알 수 없음' })),
    // Per-device usage for the "이 기기 횟수 초기화" flow (PRD §F3). `used` is the
    // number the button actually changes; `count` (finished pictures) does not
    // move on a reset, and is already behind during class because an attempt is
    // charged when the job is reserved, not when the picture lands.
    //
    // Every enrolled device appears, including ones with no picture yet: a
    // device row only exists once a job was reserved, so a zero-picture row
    // means "queued / all failed / already reset" — exactly the rows the teacher
    // opens this panel to look at.
    devices: foldDeviceUsage(devices ?? [], jobs ?? [], images ?? []),
  })
}
