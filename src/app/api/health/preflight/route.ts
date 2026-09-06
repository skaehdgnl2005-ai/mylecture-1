import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { env, spacingMs } from '@/lib/env'
import { openai } from '@/lib/openai/client'
import { requireTeacher } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface Check {
  name: string
  ok: boolean
  detail: string
  /** Shown to the teacher when ok is false. Plain Korean, actionable. */
  fix?: string
}

/**
 * "수업 전 점검" (PRD §6-2 item 7).
 *
 * Deliberately does NOT generate a real image: at 5 images/minute every test
 * image costs the class a slot. It checks reachability and configuration, and
 * reports the numbers the teacher actually needs to see before starting.
 */
export async function GET() {
  const denied = await requireTeacher()
  if (denied) return denied

  const checks: Check[] = []
  const cfg = env()

  // 1. Database — a real query, which doubles as the un-pause ping.
  const t0 = Date.now()
  const { error: dbErr, count } = await db()
    .from('sessions')
    .select('code', { count: 'exact', head: true })
  checks.push({
    name: '데이터베이스',
    ok: !dbErr,
    detail: dbErr ? dbErr.message : `연결됨 (${Date.now() - t0}ms, 세션 ${count ?? 0}개)`,
    fix: 'Supabase 프로젝트가 일시정지됐을 수 있어요. Supabase 대시보드에서 Resume을 누르고 몇 분 기다려 주세요.',
  })

  // 2. Storage bucket exists and is public.
  try {
    const { data: buckets, error } = await db().storage.listBuckets()
    const bucket = buckets?.find((b) => b.name === cfg.SUPABASE_STORAGE_BUCKET)
    checks.push({
      name: '이미지 저장소',
      ok: !error && !!bucket && bucket.public === true,
      detail: error
        ? error.message
        : !bucket
          ? `'${cfg.SUPABASE_STORAGE_BUCKET}' 버킷이 없어요`
          : bucket.public
            ? `'${bucket.name}' (공개)`
            : `'${bucket.name}' 이 비공개예요`,
      fix: `Supabase > Storage 에서 '${cfg.SUPABASE_STORAGE_BUCKET}' 이름의 public 버킷을 만들어 주세요.`,
    })
  } catch (e) {
    checks.push({ name: '이미지 저장소', ok: false, detail: String(e) })
  }

  // 3. OpenAI reachable and the key is valid — models.list is free.
  try {
    const t = Date.now()
    const models = await openai().models.list()
    const has = models.data.some((m) => m.id === cfg.IMAGE_MODEL)
    checks.push({
      name: 'OpenAI 연결',
      ok: true,
      detail: `연결됨 (${Date.now() - t}ms)${has ? '' : ` — 주의: ${cfg.IMAGE_MODEL} 모델이 목록에 없어요`}`,
    })
  } catch (e) {
    checks.push({
      name: 'OpenAI 연결',
      ok: false,
      detail: (e as Error).message,
      fix: 'OPENAI_API_KEY를 확인해 주세요.',
    })
  }

  // 4. Queue state.
  const { count: queued } = await db()
    .from('jobs').select('id', { count: 'exact', head: true }).eq('status', 'queued')
  const { count: running } = await db()
    .from('jobs').select('id', { count: 'exact', head: true }).eq('status', 'running')
  checks.push({
    name: '대기열',
    ok: (queued ?? 0) === 0 && (running ?? 0) === 0,
    detail: `대기 ${queued ?? 0}개 · 진행 중 ${running ?? 0}개`,
    fix: '지난 수업의 잔여 작업이에요. 교사 화면 > 대기열에서 정리할 수 있어요.',
  })

  // 5. The pump. pg_net is fire-and-forget: a green cron run does NOT prove the
  //    worker ran, so we look at the actual HTTP responses (kept only 6 hours).
  let pump: Check = { name: '자동 실행(pg_cron)', ok: false, detail: '확인할 수 없음' }
  try {
    const { data } = await db().rpc('cron_health')
    const row = data as { scheduled: boolean; last_response: string | null } | null
    pump = {
      name: '자동 실행(pg_cron)',
      ok: !!row?.scheduled,
      detail: row?.scheduled
        ? `등록됨${row.last_response ? ` · 최근 응답 ${row.last_response}` : ''}`
        : 'pg_cron 작업이 등록되지 않았어요',
      fix: 'supabase/migrations/0003_cron.sql 을 적용하고 Vault 시크릿을 만들어 주세요. (학생 폴링이 보조 펌프라 이것 없이도 동작은 해요)',
    }
  } catch {
    pump.detail = 'pg_cron 상태를 읽을 수 없어요 (보조 펌프로 동작함)'
  }
  checks.push(pump)

  const ipm = cfg.OPENAI_IPM
  const forty = Math.round((40 / (ipm * 0.92)) * 10) / 10
  return NextResponse.json({
    ok: checks.every((c) => c.ok),
    checks,
    config: {
      imageModel: cfg.IMAGE_MODEL,
      quality: cfg.IMAGE_QUALITY,
      size: cfg.IMAGE_SIZE,
      imagesPerMinute: ipm,
      spacingMs: spacingMs(ipm),
      maxInFlight: cfg.MAX_IN_FLIGHT,
      queueOrder: cfg.QUEUE_ORDER,
    },
    // The number the teacher must see BEFORE the lesson, not during it.
    expectations: {
      fortyImagesMinutes: forty,
      // The teacher screen prints this note directly under the big number, so
      // the two must agree. A hard-coded '약 9분' is only true at IPM=5; at
      // IPM=3 the hero would read 14.5 with '9분' beneath it.
      note:
        ipm <= 5
          ? `40장을 모두 그리는 데 약 ${forty}분이 걸려요. 화질을 낮춰도 줄어들지 않아요(한도가 장수 기준이라서요). 수업 시간은 ${Math.ceil(forty) + 6}분을 잡아 주세요.`
          : `40장을 모두 그리는 데 약 ${forty}분이 걸려요.`,
    },
  })
}
