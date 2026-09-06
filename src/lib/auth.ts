import 'server-only'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'
import { env } from './env'

const COOKIE = 'teacher_session'
const MAX_AGE_S = 60 * 60 * 8 // one school day

/**
 * Single shared password (PRD §F4 — no member system).
 *
 * The cookie carries an HMAC over an expiry, keyed by the password itself, so
 * changing TEACHER_PASSWORD invalidates every existing session for free.
 */
function sign(expiresAt: number): string {
  return createHmac('sha256', env().TEACHER_PASSWORD)
    .update(`teacher:${expiresAt}`)
    .digest('hex')
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}

export function checkPassword(candidate: string): boolean {
  return safeEqual(candidate, env().TEACHER_PASSWORD)
}

export function issueToken(): { value: string; maxAge: number } {
  const expiresAt = Date.now() + MAX_AGE_S * 1000
  return { value: `${expiresAt}.${sign(expiresAt)}`, maxAge: MAX_AGE_S }
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false
  const [expiresRaw, mac] = token.split('.')
  const expiresAt = Number(expiresRaw)
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() || !mac) return false
  return safeEqual(mac, sign(expiresAt))
}

export async function isTeacher(): Promise<boolean> {
  const jar = await cookies()
  return verifyToken(jar.get(COOKIE)?.value)
}

/** Returns a 401 response when the caller is not the teacher, else null. */
export async function requireTeacher(): Promise<NextResponse | null> {
  if (await isTeacher()) return null
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
}

export const TEACHER_COOKIE = COOKIE

// ── Login attempt throttling ────────────────────────────────────────────────
// In-memory and therefore per-instance, which is a real limitation on a
// serverless host. It is still worth having: it costs nothing and blunts the
// obvious case of one person hammering one instance. The password is the real
// control, so keep it long.
const attempts = new Map<string, { count: number; resetAt: number }>()

export function rateLimitLogin(key: string): boolean {
  const now = Date.now()
  const rec = attempts.get(key)
  if (!rec || rec.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + 60_000 })
    return true
  }
  rec.count++
  return rec.count <= 10
}

export function newSessionCode(): string {
  // Excludes 0/O/1/I/L: this is read off a projector and typed by 14-year-olds.
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(4)
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}
