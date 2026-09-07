import 'server-only'
import type { ImagesResponse, ImageGenerateParamsNonStreaming } from 'openai/resources/images'
import { openai } from './client'
import { env } from '@/lib/env'
import { assertPromptIsClean } from '@/lib/prompt/build-image-prompt'

export interface GeneratedImage {
  bytes: Buffer
  contentType: string
  extension: string
  /** Output tokens billed, when the API reports them. */
  outputTokens?: number
}

/**
 * One image. No retries here — the queue owns retries so that every attempt
 * passes back through the rate gate (OpenAI counts failed requests against the
 * per-minute limit, so a retry that bypasses the gate guarantees a 429 cascade).
 *
 * `n` is always 1: each returned image counts against IPM separately, so
 * batching would make the pacer's accounting wrong.
 *
 * `moderation` is hard-coded to 'auto' and deliberately NOT an env var. See
 * lib/env.ts.
 */
export async function generateImage(
  prompt: string,
  opts: { quality?: 'low' | 'medium' | 'high' } = {},
): Promise<GeneratedImage> {
  assertPromptIsClean(prompt) // belt and braces; the builder already checked

  const cfg = env()

  if (cfg.MOCK_OPENAI === '1') return mockImage(prompt)
  // `stream: false` is explicit so the SDK's overload resolves to the
  // non-streaming ImagesResponse rather than the Stream union.
  const res: ImagesResponse = await openai().images.generate({
    model: cfg.IMAGE_MODEL,
    prompt,
    n: 1,
    stream: false,
    size: cfg.IMAGE_SIZE as ImageGenerateParamsNonStreaming['size'],
    quality: (opts.quality ?? cfg.IMAGE_QUALITY) as ImageGenerateParamsNonStreaming['quality'],
    output_format: 'jpeg', // documented as faster than png; ~halves the payload
    moderation: 'auto',
  })

  const datum = res.data?.[0]
  if (!datum?.b64_json) {
    throw new Error('OpenAI returned no image data')
  }

  return {
    bytes: Buffer.from(datum.b64_json, 'base64'),
    contentType: 'image/jpeg',
    extension: 'jpg',
    outputTokens: res.usage?.output_tokens,
  }
}

/**
 * Re-exported from lib/pricing.ts, which is NOT server-only: the teacher's 화질
 * buttons have to print the same per-image price that 예상 비용 is computed
 * from, and a client component cannot import this file.
 *
 * `medium` used to be $0.045 here against $0.041 in the PRD. See lib/pricing.ts
 * for which one OpenAI's price list agrees with.
 *
 * The console no longer costs finished pictures at the session's CURRENT
 * quality — that made a mid-lesson change re-price pictures already drawn.
 * Migration 0008 records the quality on each job row and the console sums per
 * row via `sumCostUsd`. `estimateCostUsd` remains for FORWARD estimates, where
 * the current quality is the right one to multiply by.
 */
export { estimateCostUsd, sumCostUsd } from '@/lib/pricing'

/**
 * Deterministic stand-in used only when MOCK_OPENAI=1.
 *
 * Sleeps for a realistic 45s-ish span so the queue, the pacer, the lease
 * heartbeat and the wait screen are all exercised against real timing rather
 * than against an instant return. Scaled down by MOCK_LATENCY_MS when a test
 * needs to run fast.
 */
async function mockImage(prompt: string): Promise<GeneratedImage> {
  const latency = Number(process.env.MOCK_LATENCY_MS ?? 3000)
  await new Promise((r) => setTimeout(r, latency))

  // A 1x1 JPEG is enough: nothing downstream inspects the pixels.
  const jpeg = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
      'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
      'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    'base64',
  )
  return {
    bytes: jpeg,
    contentType: 'image/jpeg',
    extension: 'jpg',
    outputTokens: Math.min(1600, prompt.length),
  }
}
