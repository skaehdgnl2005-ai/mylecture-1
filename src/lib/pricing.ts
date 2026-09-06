/**
 * What one picture costs, in one place.
 *
 * NOT `server-only`. The teacher's 화질 buttons print these figures next to the
 * word 높음 so nobody picks the 4x option without seeing the 4x — and a screen
 * that quotes a price from a second, hand-copied table is how the price on the
 * button and the price in 예상 비용 start disagreeing. lib/openai/image.ts
 * imports this file rather than keeping its own copy.
 *
 * gpt-image-2 bills image output at $30 / 1M tokens; at IMAGE_SIZE=1024x1536
 * that is the row below. `medium` read $0.045 in image.ts and $0.041 in the PRD.
 * OpenAI's price list says $0.041 — and `low` and `high`, which both documents
 * already agreed on, are from that same 1024x1536 row, so the PRD was right and
 * the code was carrying a stale number.
 *
 * These are OUTPUT costs only. The moderation call is free and the translation
 * call is a fraction of a cent, so neither moves a classroom total.
 */
export const IMAGE_COST_USD = {
  low: 0.005,
  medium: 0.041,
  high: 0.165,
} as const

export type ImageQuality = keyof typeof IMAGE_COST_USD

/** Falls back to `medium` so an unrecognised value cannot print `$NaN`. */
export function costPerImageUsd(quality: string): number {
  return IMAGE_COST_USD[quality as ImageQuality] ?? IMAGE_COST_USD.medium
}

/** Rounded to the cent, which is the only precision a teacher acts on. */
export function estimateCostUsd(images: number, quality: string): number {
  return Math.round(images * costPerImageUsd(quality) * 100) / 100
}
