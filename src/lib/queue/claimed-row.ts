import type { JobRow } from '@/lib/db'

/**
 * "No work" from claim_job(), as it actually arrives over PostgREST.
 *
 * claim_job() is declared `returns jobs`, and its three no-work paths all
 * `return null` (too many in flight, the pacer slot has not opened, the queue
 * is empty). SQL really does return NULL — `select claim_job(...) is null` is
 * true — but PostgREST serialises a NULL composite as an OBJECT WITH EVERY
 * FIELD NULL, not as JSON null. In JavaScript that object is truthy.
 *
 * So `data ?? null` handed tick() a "job" whose every field was null: tick()
 * counted a claim, processJob() dereferenced job.inputs.place, threw, was
 * classified transient and requeued (UPDATE ... where id = null, matching
 * nothing), and the loop went straight round again with no wait — the wait only
 * happens on the `if (!job)` branch. Measured against a local Supabase: ~90
 * iterations a second and ~1,800 bogus 'requeued' rows in 20 seconds, for a
 * session whose queue was EMPTY.
 *
 * That is not a rare state. At OPENAI_IPM=5 the pacer opens a slot every 13
 * seconds, so "not our slot yet" is what claim_job() says for almost all of a
 * lesson: the worker spun flat out between every pair of pictures, burning the
 * invocation's CPU and flooding job_events. That is what RUNBOOK's "모두 대기에서
 * 멈춤" looks like from the inside.
 *
 * The id is the discriminator — a genuinely claimed row always has one.
 *
 * This lives in its own file, and takes JobRow as a TYPE-only import, so that
 * it can be unit-tested: claim.ts is `server-only` and cannot be loaded under
 * vitest's jsdom environment.
 */
export function claimedRow(data: unknown): JobRow | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const row = data as Partial<JobRow>
  return typeof row.id === 'string' && row.id.length > 0 ? (row as JobRow) : null
}
