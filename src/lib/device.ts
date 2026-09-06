'use client'

/**
 * Anonymous device identity (PRD §F3).
 *
 * Dual-stored in localStorage AND a 1-year cookie, because they fail
 * differently: localStorage survives a cookie clear, the cookie survives some
 * storage-partitioning cases, and a private window loses both.
 *
 * The known limits are accepted by the PRD: clearing browser data, private
 * mode, or a different phone all reset the count. The server-side session total
 * cap and the per-minute rate cap are what actually bound the cost.
 *
 * The server never trusts this value for anything but identity — every count is
 * computed server-side from the jobs table.
 */

const KEY = 'mirae_device_id'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365

function readCookie(name: string): string | null {
  const hit = document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${name}=`))
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null
}

function writeCookie(name: string, value: string) {
  document.cookie =
    `${name}=${encodeURIComponent(value)}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function safeLocalGet(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    // Private mode / blocked site data: the accessor itself can throw.
    return null
  }
}

function safeLocalSet(value: string) {
  try {
    localStorage.setItem(KEY, value)
  } catch {
    /* cookie is the fallback */
  }
}

export function getDeviceId(): string {
  const fromLocal = safeLocalGet()
  const fromCookie = readCookie(KEY)
  const existing = [fromLocal, fromCookie].find((v) => v && UUID_RE.test(v))

  if (existing) {
    // Heal whichever store lost it.
    if (fromLocal !== existing) safeLocalSet(existing)
    if (fromCookie !== existing) writeCookie(KEY, existing)
    return existing
  }

  const id = crypto.randomUUID()
  safeLocalSet(id)
  writeCookie(KEY, id)
  return id
}

/**
 * One key per attempt, minted when the student reaches the last step and reused
 * until that attempt resolves. This is what makes one tap one job however many
 * times a flaky connection retries the request.
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID().replace(/-/g, '')
}
