import 'server-only'
import { z } from 'zod'

/**
 * Boot-time environment validation.
 *
 * Every tunable in PRD §11 (limits, caps, concurrency, model names, poll
 * intervals) is here. The ONE deliberate exception is the image API's
 * `moderation` parameter, which is hard-coded to 'auto' in openai/image.ts:
 * anything configurable eventually gets configured, and "less restrictive
 * filtering" on a middle-school projector is not a value anyone should be able
 * to reach at 8:50am on class day.
 */
const schema = z.object({
  OPENAI_API_KEY: z.string().min(20),

  // gpt-image-1 dies 2026-10-23, gpt-image-1-mini and gpt-image-1.5 on
  // 2026-12-01. Pin a snapshot so an alias repoint cannot change the output
  // style mid-semester. Re-check the deprecations page each semester.
  IMAGE_MODEL: z.string().default('gpt-image-2'),
  IMAGE_QUALITY: z.enum(['low', 'medium', 'high']).default('medium'),
  IMAGE_SIZE: z.string().default('1024x1536'),
  TRANSLATE_MODEL: z.string().default('gpt-4.1-mini'),
  MODERATION_MODEL: z.string().default('omni-moderation-latest'),

  /**
   * The account's real images-per-minute ceiling. Tier 1 = 5, Tier 2 = 20.
   * Read it with `pnpm check:limits` — do NOT infer it from a load test, and
   * do NOT trust x-ratelimit-* headers: image endpoints do not return them.
   */
  OPENAI_IPM: z.coerce.number().int().min(1).max(250).default(5),
  /** Secondary bound only. The spacing gate is the real rate control. */
  MAX_IN_FLIGHT: z.coerce.number().int().min(1).max(20).default(4),
  QUEUE_ORDER: z.enum(['fifo', 'attempt_priority']).default('fifo'),
  MAX_TRIES: z.coerce.number().int().min(1).max(5).default(3),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SECRET_KEY: z.string().min(20),
  SUPABASE_STORAGE_BUCKET: z.string().default('drawings'),

  TEACHER_PASSWORD: z.string().min(4),
  WORKER_SECRET: z.string().min(16),
  APP_URL: z.string().url().optional(),

  POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(2500),
  GALLERY_POLL_MS: z.coerce.number().int().min(1000).default(5000),

  /**
   * Test affordance. When '1', the OpenAI clients return canned results instead
   * of calling the API. Used by the e2e suite and by a dry-run rehearsal, so a
   * full 20-student walkthrough costs nothing and does not consume the class's
   * images-per-minute budget. Never set in production.
   */
  MOCK_OPENAI: z.enum(['0', '1']).default('0'),

  DEFAULT_PER_DEVICE_LIMIT: z.coerce.number().int().min(1).max(10).default(2),
  DEFAULT_TOTAL_LIMIT: z.coerce.number().int().min(1).max(500).default(50),
})

let cached: z.infer<typeof schema> | null = null

export function env() {
  if (cached) return cached
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}\n\nSee .env.example`)
  }
  cached = parsed.data
  return cached
}

/**
 * Minimum milliseconds between OpenAI request STARTS.
 *
 * 60000 / (IPM * 0.92) — an 8% headroom band. The headroom is not padding:
 * OpenAI documents that unsuccessful requests also count against the per-minute
 * limit, and image endpoints publish no remaining-images counter to check
 * against, so a single unaccounted 429 must not be able to push us over.
 *
 * At IPM=5 this is 13,044ms => 4.60 images/min.
 */
export function spacingMs(ipm = env().OPENAI_IPM): number {
  return Math.ceil(60_000 / (ipm * 0.92))
}

/**
 * Honest wait estimate for the student's "앞에 N명" screen.
 * position 1 means "you are next".
 */
export function etaSeconds(position: number, ipm = env().OPENAI_IPM): number {
  const GENERATE_SECONDS = 45 // measured gpt-image-2 medium 1024x1536 median
  return Math.round(((Math.max(0, position - 1) * spacingMs(ipm)) / 1000) + GENERATE_SECONDS)
}
