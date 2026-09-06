import 'server-only'
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
  const res = await openai().images.generate({
    model: cfg.IMAGE_MODEL,
    prompt,
    n: 1,
    size: cfg.IMAGE_SIZE as '1024x1536',
    quality: (opts.quality ?? cfg.IMAGE_QUALITY) as 'medium',
    output_format: 'jpeg', // documented as faster than png; ~halves the payload
    moderation: 'auto',
  } as Parameters<ReturnType<typeof openai>['images']['generate']>[0])

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

/** Rough cost estimate for the teacher console. ~$30 / 1M image output tokens. */
export function estimateCostUsd(images: number, quality: string): number {
  const perImage = quality === 'high' ? 0.165 : quality === 'low' ? 0.005 : 0.045
  return Math.round(images * perImage * 100) / 100
}
