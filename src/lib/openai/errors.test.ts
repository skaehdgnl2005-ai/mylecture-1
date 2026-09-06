import { describe, it, expect } from 'vitest'
import { classifyImageError, backoffMs } from './errors'

const err = (init: Record<string, unknown>) => init as unknown

describe('classifyImageError — 429 must split money from pacing', () => {
  it('treats a plain rate-limit 429 as retryable', () => {
    const f = classifyImageError(err({ status: 429, error: { code: 'slow_down', message: 'slow down' } }))
    expect(f.kind).toBe('rate_limit')
    expect(f.retryable).toBe(true)
  })

  it('treats a 429 with no error code as retryable pacing', () => {
    const f = classifyImageError(err({ status: 429, error: { message: 'Rate limit reached for requests' } }))
    expect(f.kind).toBe('rate_limit')
    expect(f.retryable).toBe(true)
  })

  // These never clear during a 50-minute lesson. Retrying them just burns
  // rate-limit slots that other students need.
  const billing = [
    'credit_balance_exhausted',
    'organization_spend_limit_exceeded',
    'project_spend_limit_exceeded',
    'organization_usage_limit_exceeded',
  ]
  for (const code of billing) {
    it(`treats ${code} as non-retryable billing`, () => {
      const f = classifyImageError(err({ status: 429, error: { code, message: 'no money' } }))
      expect(f.kind).toBe('billing')
      expect(f.retryable).toBe(false)
    })
  }

  it('parses Retry-After from a plain header object', () => {
    const f = classifyImageError(err({ status: 429, headers: { 'retry-after': '7' }, error: {} }))
    expect(f.retryAfterSec).toBe(7)
  })

  it('parses Retry-After from a Headers-like object', () => {
    const headers = new Headers({ 'retry-after': '3' })
    const f = classifyImageError(err({ status: 429, headers, error: {} }))
    expect(f.retryAfterSec).toBe(3)
  })
})

describe('classifyImageError — moderation stage decides who gets blamed', () => {
  it('input-stage blocks are deterministic and must not be retried', () => {
    const f = classifyImageError(err({
      status: 400,
      error: {
        type: 'image_generation_user_error',
        code: 'moderation_blocked',
        message: 'blocked',
        moderation_details: { moderation_stage: 'input', categories: ['harassment'] },
      },
    }))
    expect(f.kind).toBe('moderation_input')
    expect(f.retryable).toBe(false)
  })

  it('output-stage blocks are not the student’s fault and may be retried once', () => {
    const f = classifyImageError(err({
      status: 400,
      error: {
        type: 'image_generation_user_error',
        code: 'moderation_blocked',
        message: 'blocked',
        moderation_details: { moderation_stage: 'output' },
      },
    }))
    expect(f.kind).toBe('moderation_output')
    expect(f.retryable).toBe(true)
  })

  it('defaults to the output reading when the stage is missing', () => {
    const f = classifyImageError(err({
      status: 400,
      error: { code: 'moderation_blocked', message: 'blocked' },
    }))
    expect(f.kind).toBe('moderation_output')
  })
})

describe('classifyImageError — everything else', () => {
  it('5xx is transient and retryable', () => {
    expect(classifyImageError(err({ status: 503, error: {} })).retryable).toBe(true)
  })

  it('a network error with no status is transient', () => {
    expect(classifyImageError(new Error('socket hang up')).kind).toBe('transient')
  })

  it('a 400 we caused is not retryable', () => {
    const f = classifyImageError(err({ status: 400, error: { code: 'invalid_size', message: 'bad size' } }))
    expect(f.kind).toBe('bad_request')
    expect(f.retryable).toBe(false)
  })
})

describe('backoffMs — never retry faster than one rate slot', () => {
  const SPACING = 13_044 // IPM=5
  const noJitter = () => 0

  it('a Retry-After of 0.0 seconds cannot produce a tight loop', () => {
    // OpenAI image endpoints have been observed returning exactly this.
    expect(backoffMs(1, SPACING, 0, noJitter)).toBeGreaterThanOrEqual(SPACING)
  })

  it('a Retry-After shorter than a slot is floored at one slot', () => {
    expect(backoffMs(1, SPACING, 1, noJitter)).toBeGreaterThanOrEqual(SPACING)
  })

  it('a Retry-After longer than the exponential wins', () => {
    expect(backoffMs(1, SPACING, 60, noJitter)).toBe(60_000)
  })

  it('grows exponentially across attempts', () => {
    expect(backoffMs(1, SPACING, undefined, noJitter)).toBe(SPACING)
    expect(backoffMs(2, SPACING, undefined, noJitter)).toBe(SPACING * 2)
    expect(backoffMs(3, SPACING, undefined, noJitter)).toBe(SPACING * 4)
  })

  it('adds jitter so simultaneous failures do not return simultaneously', () => {
    const a = backoffMs(1, SPACING, undefined, () => 0)
    const b = backoffMs(1, SPACING, undefined, () => 0.999)
    expect(b - a).toBeGreaterThan(3000)
    expect(b - a).toBeLessThanOrEqual(4000)
  })
})
