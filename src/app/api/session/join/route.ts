import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db, type SessionRow } from '@/lib/db'
import { sessionUsage } from '@/lib/quota'
import { env } from '@/lib/env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  code: z.string().regex(/^[A-Za-z0-9]{4}$/),
  deviceId: z.string().uuid(),
})

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ ok: false, message: '코드를 다시 확인해 주세요.' }, { status: 400 })
  }
  const code = parsed.data.code.toUpperCase()

  const { data } = await db().from('sessions').select('*').eq('code', code).maybeSingle()
  const session = data as SessionRow | null

  if (!session) {
    return NextResponse.json(
      { ok: false, message: '그런 코드가 없어요. 화면의 코드를 다시 확인해 주세요.' },
      { status: 404 },
    )
  }
  // 'draining' means the teacher has closed the lesson and the queue is
  // finishing. New submissions are refused (POST /api/jobs requires 'open'), so
  // say it here rather than letting a student fill in five steps first.
  if (session.status === 'closed' || session.status === 'draining') {
    return NextResponse.json(
      { ok: false, message: '오늘 수업은 끝났어요. 갤러리는 계속 볼 수 있어요.', closed: true },
      { status: 200 },
    )
  }

  const usage = await sessionUsage(session, parsed.data.deviceId)

  return NextResponse.json({
    ok: true,
    session: {
      code: session.code,
      allowedStyles: session.allowed_styles,
      perDeviceLimit: session.per_device_limit,
      status: session.status,
    },
    usage,
    pollIntervalMs: env().POLL_INTERVAL_MS,
  })
}
