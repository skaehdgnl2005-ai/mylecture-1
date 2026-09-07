import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env } from './env'

let admin: SupabaseClient | null = null

/**
 * The ONLY Supabase client in the app, and it is server-only.
 *
 * There is deliberately no NEXT_PUBLIC_SUPABASE_* variable anywhere: the
 * browser never holds a Supabase key. Every read and write goes through a Route
 * Handler that selects exactly the columns it means to expose, which is what
 * makes PRD §F2's anonymity enforceable in one place a reviewer can read.
 *
 * The secret key bypasses RLS by design; RLS is enabled with zero policies as a
 * second, independent lock (see 0001_schema.sql).
 */
export function db(): SupabaseClient {
  if (admin) return admin
  admin = createClient(env().SUPABASE_URL, env().SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application-name': 'mirae-draw' } },
  })
  return admin
}

export interface SessionRow {
  code: string
  status: 'open' | 'draining' | 'closed'
  per_device_limit: number
  total_limit: number
  per_minute_limit: number
  allowed_styles: string[]
  image_quality: 'low' | 'medium' | 'high'
  queue_order: 'fifo' | 'attempt_priority'
  created_at: string
  closed_at: string | null
}

export interface JobRow {
  id: string
  session_code: string
  device_id: string
  idempotency_key: string
  attempt_no: number
  inputs: Record<string, unknown>
  raw_text_ko: string | null
  action_en: string | null
  visible_detail_en: string | null
  prompt: string | null
  status: 'queued' | 'running' | 'done' | 'failed'
  /** Quality this picture was drawn at. NULL until it is drawn. See 0008. */
  image_quality: 'low' | 'medium' | 'high' | null
  tries: number
  next_attempt_at: string
  lease_expires_at: string | null
  deadline_at: string
  error_code: string | null
  error_message: string | null
  created_at: string
  finished_at: string | null
}

export async function logEvent(
  kind: string,
  opts: { jobId?: string; sessionCode?: string; detail?: Record<string, unknown> } = {},
): Promise<void> {
  // Vercel Hobby keeps runtime logs for 1 hour and Supabase for 1 day; neither
  // survives to the next morning when a teacher asks what happened to one
  // student's picture. So we keep our own.
  try {
    await db().from('job_events').insert({
      job_id: opts.jobId ?? null,
      session_code: opts.sessionCode ?? null,
      kind,
      detail: opts.detail ?? null,
    })
  } catch {
    // Never let logging break the pipeline.
  }
}
