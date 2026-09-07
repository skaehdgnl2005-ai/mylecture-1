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

/**
 * What a session's finished pictures actually cost, from a per-row tally.
 *
 * `estimateCostUsd(done, session.image_quality)` above prices every finished
 * picture at whatever quality the session is set to RIGHT NOW. Quality is a
 * mid-lesson setting, so that made the console re-price pictures backwards: a
 * teacher who switched low -> high at minute 8 watched the 20 pictures already
 * drawn jump from $0.10 to $3.30. Nothing had been spent; the number the
 * teacher uses to decide whether they can finish the lesson was simply wrong.
 *
 * Migration 0008 writes the quality onto each job row when it is drawn, so the
 * honest total is a sum over rows. `counts` is keyed by quality, as returned by
 * the session_quality_counts() function.
 *
 * `fallbackQuality` prices the 'unknown' bucket — rows finished before the
 * column was being written. That is the old approximation, now confined to the
 * rows where there is genuinely nothing recorded, instead of applied to all of
 * them.
 */
export function sumCostUsd(
  counts: Record<string, number>,
  fallbackQuality: string,
): number {
  let total = 0
  for (const [quality, n] of Object.entries(counts)) {
    if (!Number.isFinite(n) || n <= 0) continue
    total += n * costPerImageUsd(quality === 'unknown' ? fallbackQuality : quality)
  }
  return Math.round(total * 100) / 100
}
