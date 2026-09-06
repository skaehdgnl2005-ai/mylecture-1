import { NextResponse } from 'next/server'
import { checkPassword, issueToken, rateLimitLogin, TEACHER_COOKIE } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const ip = req.headers.get('x-forwarded-for') ?? 'local'
  if (!rateLimitLogin(ip)) {
    return NextResponse.json({ ok: false, message: '잠시 뒤 다시 시도해 주세요.' }, { status: 429 })
  }

  const body = (await req.json().catch(() => null)) as { password?: string } | null
  if (!body?.password || !checkPassword(body.password)) {
    return NextResponse.json({ ok: false, message: '비밀번호가 맞지 않아요.' }, { status: 401 })
  }

  const token = issueToken()
  const res = NextResponse.json({ ok: true })
  res.cookies.set(TEACHER_COOKIE, token.value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: token.maxAge,
  })
  return res
}
