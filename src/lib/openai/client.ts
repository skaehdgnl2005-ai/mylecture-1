import 'server-only'
import OpenAI from 'openai'
import { env } from '@/lib/env'

let client: OpenAI | null = null

/**
 * The SDK defaults are actively hostile for this workload, so both are overridden:
 *
 *  - `timeout` defaults to TEN MINUTES. One wedged call would hold a worker slot
 *    for the entire lesson.
 *  - `maxRetries` defaults to 2. Multiplied with our own 3-attempt loop that is
 *    up to 9 real, billable, rate-limit-consuming calls per job — and OpenAI
 *    documents that unsuccessful requests still count against the per-minute
 *    limit. Retries belong to the queue, which paces them; they must not also
 *    happen invisibly inside the SDK.
 */
export function openai(): OpenAI {
  if (client) return client
  client = new OpenAI({
    apiKey: env().OPENAI_API_KEY,
    maxRetries: 0,
    timeout: 120_000,
  })
  return client
}
