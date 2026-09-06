/**
 * Error classification for the image queue.
 *
 * Pure functions with no SDK import, so they are unit-testable without network
 * or credentials. The worker maps an SDK error into `ImageFailure` and then only
 * reasons about that.
 */

export type FailureKind =
  /** 429 pacing. Retryable, but only after a full rate slot. */
  | 'rate_limit'
  /** 429 because money ran out. Will NEVER clear during a 50-minute lesson. */
  | 'billing'
  /** The prompt was rejected. Deterministic — retrying burns a real image slot. */
  | 'moderation_input'
  /** The drawing came out disallowed. Not the student's fault; one retry may help. */
  | 'moderation_output'
  /** 5xx / network / timeout. Retryable. */
  | 'transient'
  /** 4xx we caused. Not retryable. */
  | 'bad_request'

export interface ImageFailure {
  kind: FailureKind
  retryable: boolean
  status?: number
  code?: string
  message: string
  /** Seconds parsed from a Retry-After header, when present. */
  retryAfterSec?: number
}

const BILLING_CODES = new Set([
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'insufficient_quota',
  'billing_hard_limit_reached',
])

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined
  const h = headers as Record<string, unknown> & { get?: (k: string) => string | null }
  if (typeof h.get === 'function') return h.get(name) ?? undefined
  const found = Object.entries(h).find(([k]) => k.toLowerCase() === name)
  return found ? String(found[1]) : undefined
}

function parseRetryAfter(headers: unknown): number | undefined {
  const raw = headerValue(headers, 'retry-after')
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function classifyImageError(err: unknown): ImageFailure {
  const e = err as any
  const status: number | undefined = e?.status ?? e?.response?.status
  const body = e?.error ?? e?.response?.data?.error ?? {}
  const code: string | undefined = body?.code ?? e?.code
  const type: string | undefined = body?.type ?? e?.type
  const message: string = body?.message ?? e?.message ?? String(err)
  const retryAfterSec = parseRetryAfter(e?.headers ?? e?.response?.headers)

  // Moderation. The documented shape is
  //   error.type = 'image_generation_user_error'
  //   error.code = 'moderation_blocked'
  //   error.moderation_details.moderation_stage = 'input' | 'output'
  if (code === 'moderation_blocked' || type === 'image_generation_user_error') {
    const stage: string | undefined =
      body?.moderation_details?.moderation_stage ?? e?.moderation_details?.moderation_stage
    // Default to the OUTPUT reading when the stage is missing. Blaming a student
    // for an output-stage block is both wrong and, in a classroom, humiliating.
    const isInput = stage === 'input'
    return {
      kind: isInput ? 'moderation_input' : 'moderation_output',
      retryable: !isInput, // an input block is deterministic; retrying wastes a slot
      status, code, message,
    }
  }

  if (status === 429) {
    if (code && BILLING_CODES.has(code)) {
      return { kind: 'billing', retryable: false, status, code, message, retryAfterSec }
    }
    // 'slow_down', or a plain rate-limit 429 with no code at all.
    return { kind: 'rate_limit', retryable: true, status, code, message, retryAfterSec }
  }

  if (status === undefined || status >= 500 || status === 408) {
    return { kind: 'transient', retryable: true, status, code, message, retryAfterSec }
  }

  return { kind: 'bad_request', retryable: false, status, code, message }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Delay before the next attempt.
 *
 * Two rules that are easy to get wrong and expensive to get wrong:
 *
 *  1. NEVER retry faster than one rate slot. OpenAI's own docs hedge on
 *     Retry-After for image endpoints ("when it's present"), and users report
 *     429 bodies literally saying "try again after 0.0 seconds". Honouring that
 *     verbatim produces a tight retry loop that gets the account flagged.
 *  2. Jitter, so twenty jobs that failed in the same second do not all come
 *     back in the same second.
 *
 * The retry still passes through claim_job()'s gate afterwards; this only sets
 * the earliest time the job becomes claimable again.
 */
export function backoffMs(
  attempt: number,
  spacingMs: number,
  retryAfterSec?: number,
  rand: () => number = Math.random,
): number {
  const exponential = spacingMs * Math.pow(2, Math.max(0, attempt - 1))
  const fromHeader = retryAfterSec != null ? retryAfterSec * 1000 : 0
  const jitter = Math.floor(rand() * 4000)
  return Math.max(spacingMs, exponential, fromHeader) + jitter
}
