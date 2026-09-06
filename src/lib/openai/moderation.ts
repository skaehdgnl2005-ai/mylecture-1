import 'server-only'
import { openai } from './client'
import { env } from '@/lib/env'

export type ModerationVerdict =
  | { ok: true }
  | { ok: false; reason: 'selfharm' | 'flagged'; fieldIndex: number; categories: string[] }

/**
 * Self-harm thresholds are deliberately lower than the API's own `flagged`
 * boolean, which is calibrated for a general adult population. This cohort is
 * fourteen. A false positive costs one soft message; a false negative costs
 * something that cannot be undone.
 */
const SELF_HARM_THRESHOLD = 0.15
const SELF_HARM_CATEGORIES = ['self-harm', 'self-harm/intent', 'self-harm/instructions']

/**
 * Screens both free-text fields in ONE call by passing an array. The response
 * returns one result per input IN ORDER, which is what makes PRD §5-3's
 * "tell them roughly which answer was the problem" possible at all.
 *
 * Free, and 500 RPM even at Tier 1, so there is no reason not to screen
 * every submission.
 */
export async function moderateFields(fields: string[]): Promise<ModerationVerdict> {
  const nonEmpty = fields.map((f) => f.trim())
  if (nonEmpty.every((f) => f.length === 0)) return { ok: true }

  // MOCK_OPENAI leaves layer 1 (the deterministic word list) fully active, so
  // safety behaviour is still exercised end to end — only the network call goes.
  if (env().MOCK_OPENAI === '1') return { ok: true }

  const res = await openai().moderations.create({
    model: env().MODERATION_MODEL,
    input: nonEmpty.map((f) => (f.length ? f : ' ')),
  })

  for (let i = 0; i < res.results.length; i++) {
    const r = res.results[i]
    const scores = r.category_scores as unknown as Record<string, number>

    const selfHarmHit = SELF_HARM_CATEGORIES.some((c) => (scores?.[c] ?? 0) > SELF_HARM_THRESHOLD)
    if (selfHarmHit) {
      return { ok: false, reason: 'selfharm', fieldIndex: i, categories: SELF_HARM_CATEGORIES }
    }

    if (r.flagged) {
      const categories = Object.entries(r.categories as unknown as Record<string, boolean>)
        .filter(([, v]) => v)
        .map(([k]) => k)
      return { ok: false, reason: 'flagged', fieldIndex: i, categories }
    }
  }

  return { ok: true }
}
