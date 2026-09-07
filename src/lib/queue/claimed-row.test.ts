import { describe, it, expect } from 'vitest'
import { claimedRow } from './claimed-row'

/**
 * The all-null object below is not invented: it is the verbatim body PostgREST
 * returns for `POST /rest/v1/rpc/claim_job` when claim_job() returns SQL NULL
 * (checked against a local Supabase — `select claim_job(...) is null` is true
 * at the same moment). Treating it as a job is what sent the worker into a
 * ~90-iterations-a-second requeue loop, so it is pinned here literally.
 */
const NO_WORK = {
  id: null, session_code: null, device_id: null, idempotency_key: null,
  attempt_no: null, inputs: null, raw_text_ko: null, action_en: null,
  visible_detail_en: null, prompt: null, status: null, tries: null,
  next_attempt_at: null, lease_expires_at: null, deadline_at: null,
  error_code: null, error_message: null, created_at: null, finished_at: null,
  image_quality: null,
}

describe('claimedRow', () => {
  it('reads PostgREST\'s all-null composite as "no work"', () => {
    expect(claimedRow(NO_WORK)).toBeNull()
  })

  it('still reads a real claim as a job', () => {
    const job = { ...NO_WORK, id: 'e6f1c0a2-0000-4000-8000-000000000001', status: 'running', tries: 1 }
    expect(claimedRow(job)).toBe(job)
  })

  it('handles the shapes a driver might hand back instead', () => {
    expect(claimedRow(null)).toBeNull()
    expect(claimedRow(undefined)).toBeNull()
    expect(claimedRow([])).toBeNull()          // PostgREST set-returning shape
    expect(claimedRow('')).toBeNull()
    expect(claimedRow({})).toBeNull()
    expect(claimedRow({ id: '' })).toBeNull()  // empty id is not a claim
  })
})
