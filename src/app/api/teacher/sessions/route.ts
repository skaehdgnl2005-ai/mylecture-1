import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db, logEvent, type SessionRow } from '@/lib/db'
import { requireTeacher, newSessionCode } from '@/lib/auth'
import { env, spacingMs } from '@/lib/env'
import { estimateCostUsd } from '@/lib/openai/image'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** List sessions plus live counts for the dashboard. */
export async function GET() {
  const denied = await requireTeacher()
  if (denied) return denied

  const { data: sessions } = await db()
    .from('sessions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(30)

  const rows = (sessions ?? []) as SessionRow[]
  const active = rows.find((s) => s.status === 'open' || s.status === 'draining')

  let stats = null
  if (active) {
    const counts = await Promise.all(
      (['queued', 'running', 'done', 'failed'] as const).map(async (status) => {
        const { count } = await db()
          .from('jobs')
          .select('id', { count: 'exact', head: true })
          .eq('session_code', active.code)
          .eq('status', status)
        return [status, count ?? 0] as const
      }),
    )
    const map = Object.fromEntries(counts) as Record<string, number>

    // Observed rate over the last minute — the number that tells the teacher
    // whether the gate is actually doing what it claims.
    const { count: lastMinute } = await db()
      .from('job_events')
      .select('id', { count: 'exact', head: true })
      .eq('kind', 'claimed')
      .gte('at', new Date(Date.now() - 60_000).toISOString())

    const { count: devices } = await db()
      .from('devices')
      .select('id', { count: 'exact', head: true })
      .eq('session_code', active.code)

    const pending = map.queued + map.running
    stats = {
      ...map,
      devices: devices ?? 0,
      observedIpm: lastMinute ?? 0,
      estimatedCostUsd: estimateCostUsd(map.done, active.image_quality),
      // Honest remaining-time estimate at the real ceiling.
      etaMinutes:
        pending === 0
          ? 0
          : Math.round((pending * spacingMs(Math.min(active.per_minute_limit, env().OPENAI_IPM))) / 6000) / 10,
    }
  }

  return NextResponse.json({ sessions: rows, active: active ?? null, stats })
}

const Create = z.object({
  perDeviceLimit: z.number().int().min(1).max(10).optional(),
  totalLimit: z.number().int().min(1).max(500).optional(),
  allowedStyles: z.array(z.enum(['anime', 'photo', 'watercolor'])).min(1).optional(),
})

/**
 * Create a session. PRD §F4: only one may be active, so any previously open one
 * is closed first. Closing goes through 'draining' rather than straight to
 * 'closed' so jobs already in flight still finish — otherwise the last student
 * to submit before the teacher clicks would be stranded.
 */
export async function POST(req: Request) {
  const denied = await requireTeacher()
  if (denied) return denied

  const parsed = Create.safeParse(await req.json().catch(() => ({})))
  const opts = parsed.success ? parsed.data : {}
  const cfg = env()

  await db()
    .from('sessions')
    .update({ status: 'closed', closed_at: new Date().toISOString() })
    .in('status', ['open', 'draining'])

  // The unique partial index guarantees only one 'open' row; retry on the
  // astronomically unlikely code collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newSessionCode()
    const { data, error } = await db()
      .from('sessions')
      .insert({
        code,
        per_device_limit: opts.perDeviceLimit ?? cfg.DEFAULT_PER_DEVICE_LIMIT,
        total_limit: opts.totalLimit ?? cfg.DEFAULT_TOTAL_LIMIT,
        per_minute_limit: cfg.OPENAI_IPM,
        allowed_styles: opts.allowedStyles ?? ['anime', 'photo', 'watercolor'],
        image_quality: cfg.IMAGE_QUALITY,
        queue_order: cfg.QUEUE_ORDER,
      })
      .select()
      .single()

    if (!error && data) {
      await logEvent('session_created', { sessionCode: code })
      return NextResponse.json({ ok: true, session: data }, { status: 201 })
    }
    if (error && !error.message.includes('duplicate')) {
      return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
    }
  }

  return NextResponse.json({ ok: false, message: '세션을 만들지 못했어요.' }, { status: 500 })
}
