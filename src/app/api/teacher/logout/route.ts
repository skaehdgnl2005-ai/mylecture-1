import { NextResponse } from 'next/server'
import { TEACHER_COOKIE } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  const res = NextResponse.json({ ok: true })
  res.cookies.set(TEACHER_COOKIE, '', { path: '/', maxAge: 0 })
  return res
}
