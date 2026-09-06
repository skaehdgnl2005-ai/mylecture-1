'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { STYLE_CARDS } from '@/lib/chips'

/**
 * "스타일 예시 생성" (PRD §F4, RUNBOOK 수업 전날 3번).
 *
 * These are three REAL images out of a 5-images-per-minute budget. Pressing this
 * during a lesson costs the class three slots — about 40 seconds — and shifts
 * every waiting student's queue position, which is why the warning sits next to
 * the button and why a live session adds a second confirm.
 *
 * The GET is treated as the truth, not the POST response: the route upserts each
 * style the moment it lands, so a dropped connection, a reload, or a function cut
 * off at maxDuration still leaves the panel showing what actually exists.
 */

/** One row of GET /api/teacher/style-samples. Matches the route's select list. */
interface Sample {
  style: string
  url: string
  created_at: string
}

/** One entry of POST /api/teacher/style-samples -> { ok, results }. */
export interface StyleSampleResult {
  style: string
  ok: boolean
  error?: string
}

type Phase = 'loading' | 'idle' | 'running'

const CONFIRM_FIRST = '스타일 예시 3장을 만들까요?\n진짜 그림 3장을 그려서 1~2분 걸려요.'
const CONFIRM_REPLACE = '지금 있는 예시를 지우고 3장을 새로 만들까요?\n진짜 그림 3장을 그려서 1~2분 걸려요.'
const CONFIRM_OPEN = '지금 수업이 열려 있어요.\n수업 중에는 만들지 않는 게 좋아요. 그래도 만들까요?'
const confirmOpenWaiting = (n: number) =>
  `지금 수업이 열려 있어요.\n기다리는 학생 작업 ${n}개가 그만큼 더 밀려요. 그래도 만들까요?`

/** Pure, so the three-way outcome can be unit-tested without a DOM. */
export function summarize(results: StyleSampleResult[]): { tone: 'ok' | 'warn' | 'bad'; text: string } {
  const okCount = results.filter((r) => r.ok).length
  if (okCount === results.length) return { tone: 'ok', text: `예시 ${results.length}장을 모두 만들었어요.` }
  if (okCount === 0) {
    return {
      tone: 'bad',
      text: '예시를 만들지 못했어요. 잠시 뒤에 다시 해 주세요. 지금 있는 예시는 그대로 남아 있어요.',
    }
  }
  return {
    tone: 'warn',
    // "3장" is literal on purpose: the route always attempts all three.
    text: `${results.length}장 중 ${okCount}장만 만들어졌어요. 다시 만들기를 누르면 3장을 모두 다시 그려요.`,
  }
}

export function StyleSamplePanel({
  sessionOpen,
  pendingJobs,
}: {
  /** true while a lesson is live — escalates the warning and adds a second confirm. */
  sessionOpen: boolean
  /** stats.queued + stats.running, only to make that second confirm concrete. */
  pendingJobs: number
}) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [samples, setSamples] = useState<Sample[]>([])
  const [results, setResults] = useState<StyleSampleResult[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const baseline = useRef<Record<string, string>>({})
  const startedAt = useRef(0)

  const load = useCallback(async () => {
    const res = await fetch('/api/teacher/style-samples', { cache: 'no-store' })
    if (res.status === 401) {
      setNotice('로그인이 풀렸어요. 화면을 새로 고쳐 주세요.')
      return
    }
    if (!res.ok) {
      setNotice('예시를 불러오지 못했어요. 화면을 새로 고쳐 주세요.')
      return
    }
    const d = await res.json()
    setSamples((d.samples ?? []) as Sample[])
  }, [])

  useEffect(() => {
    load().finally(() => setPhase((p) => (p === 'loading' ? 'idle' : p)))
  }, [load])

  const generate = async () => {
    if (!window.confirm(samples.length > 0 ? CONFIRM_REPLACE : CONFIRM_FIRST)) return
    // Second step only while a lesson is live. Same spirit as deleteSession's
    // two-step confirm: a mis-click must not be able to cost the class three slots.
    if (sessionOpen && !window.confirm(pendingJobs > 0 ? confirmOpenWaiting(pendingJobs) : CONFIRM_OPEN)) return

    baseline.current = Object.fromEntries(samples.map((s) => [s.style, s.url]))
    startedAt.current = Date.now()
    setElapsed(0)
    setResults(null)
    setNotice(null)
    setPhase('running')

    try {
      // No AbortController and no AbortSignal.timeout(): three images at the
      // pacer's spacing take ~26s of enforced gap plus three real generations,
      // and giving up early would not un-bill an image already in flight — it
      // would only hide the outcome. maxDuration=300 on the route is the bound.
      const res = await fetch('/api/teacher/style-samples', { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (res.status === 401) setNotice('로그인이 풀렸어요. 화면을 새로 고쳐 주세요.')
      else if (!res.ok) setNotice('예시를 다 만들지 못했어요. 아래 그림을 확인하고 필요하면 다시 만들어 주세요.')
      else setResults((d.results ?? []) as StyleSampleResult[])
    } catch {
      setNotice('결과를 받지 못했어요. 아래 그림으로 확인해 주세요.')
    } finally {
      setPhase('idle')
      await load()
    }
  }

  useEffect(() => {
    if (phase !== 'running') return
    // Elapsed is derived from Date.now(), never from a tick counter: a
    // backgrounded tab throttles setInterval to about once a minute and a
    // counter would then under-report the wait.
    const tick = setInterval(() => setElapsed(Math.round((Date.now() - startedAt.current) / 1000)), 1000)
    // The POST only answers at the very end, but the route upserts each style the
    // moment it lands — polling the GET is what turns a two-minute spinner into
    // visible progress, with no new endpoint.
    const poll = setInterval(load, 5000)
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => {
      clearInterval(tick)
      clearInterval(poll)
      window.removeEventListener('beforeunload', warn)
    }
  }, [phase, load])

  const running = phase === 'running'
  const byStyle = new Map(samples.map((s) => [s.style, s]))
  // Compare the URL, not created_at, and not a wall clock.
  //
  // created_at looks like the natural choice and is the wrong one: the route
  // upserts { style, url, storage_path }, so on the conflict path Postgres
  // updates only those three columns and created_at keeps its ORIGINAL insert
  // value (0006_style_samples.sql gives it a default, not a trigger). Every run
  // after the very first would therefore show no progress at all.
  //
  // The URL always moves: imageKey() mints a fresh random object key per image,
  // and the route deliberately never overwrites a storage path.
  const isNew = (id: string) => {
    const s = byStyle.get(id)
    return !!s && s.url !== baseline.current[id]
  }
  const doneCount = running ? STYLE_CARDS.filter((c) => isNew(c.id)).length : 0
  const drawingId = running ? STYLE_CARDS.find((c) => !isNew(c.id))?.id : undefined
  const mmss = elapsed >= 60 ? `${Math.floor(elapsed / 60)}분 ${elapsed % 60}초` : `${elapsed}초`
  const summary = results && results.length > 0 ? summarize(results) : null

  return (
    <section className="space-y-4 rounded-3xl bg-white p-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold text-gray-900">스타일 예시</h2>
        {sessionOpen && (
          <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
            지금 수업이 열려 있어요
          </span>
        )}
      </div>
      <p className="text-sm text-gray-500">
        학생 화면의 스타일 카드에 보이는 그림이에요. 한 번 만들어 두면 계속 쓰여요.
      </p>

      {notice && <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">{notice}</div>}

      {summary && (
        <div
          role="status"
          className={clsx(
            'rounded-2xl px-4 py-3 text-sm leading-relaxed',
            summary.tone === 'ok' && 'bg-green-50 text-green-800',
            summary.tone === 'warn' && 'bg-amber-50 text-amber-900',
            summary.tone === 'bad' && 'bg-red-50 text-red-800',
          )}
        >
          {summary.text}
        </div>
      )}

      <div className="grid max-w-md grid-cols-3 gap-3">
        {STYLE_CARDS.map((c) => {
          const s = byStyle.get(c.id)
          const result = results?.find((r) => r.style === c.id)
          return (
            <div key={c.id} className="space-y-1.5">
              <div
                className={clsx(
                  'overflow-hidden rounded-xl bg-gray-100',
                  running && !isNew(c.id) && 'opacity-40',
                )}
              >
                {s ? (
                  // Plain <img>, like StepForm's style cards: next/image only
                  // accepts *.supabase.co per next.config.ts, so a local
                  // `supabase start` host 400s. These are three low-quality
                  // thumbnails where optimisation buys nothing anyway.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.url} alt="" className="aspect-[2/3] w-full object-cover" />
                ) : (
                  <div className="flex aspect-[2/3] w-full items-center justify-center text-xs text-gray-300">
                    아직 없어요
                  </div>
                )}
              </div>
              <div className="text-sm font-semibold text-gray-900">{c.ko}</div>
              {running ? (
                <div
                  className={clsx(
                    'text-[11px]',
                    isNew(c.id) ? 'text-green-700' : c.id === drawingId ? 'text-brand-600' : 'text-gray-400',
                  )}
                >
                  {isNew(c.id) ? '완료' : c.id === drawingId ? '그리는 중…' : '기다리는 중'}
                </div>
              ) : result ? (
                <>
                  <div className={clsx('text-[11px]', result.ok ? 'text-green-700' : 'text-red-600')}>
                    {result.ok ? '방금 만들었어요' : '실패'}
                  </div>
                  {!result.ok && result.error && (
                    <div className="text-[11px] break-words text-gray-400">{result.error}</div>
                  )}
                </>
              ) : (
                <div className="text-[11px] text-gray-400">
                  {s ? new Date(s.created_at).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' }) : '아직 없어요'}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="space-y-2 border-t border-gray-100 pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={generate}
            disabled={phase !== 'idle'}
            className="rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {running ? `만드는 중… ${mmss}` : '스타일 예시 생성'}
          </button>
          {running && (
            <span className="text-sm text-gray-500" aria-live="polite">
              3장 중 {doneCount}장 완료
            </span>
          )}
        </div>

        <p className={clsx('text-xs leading-relaxed', sessionOpen ? 'text-amber-700' : 'text-gray-400')}>
          {sessionOpen
            ? '지금 수업이 열려 있어요. 지금 누르면 학생 그림 3장 분량을 먼저 가져가요. 수업이 끝난 뒤에 만들어 주세요.'
            : '수업 전날에 만들어 주세요. 진짜 그림 3장을 그리기 때문에, 수업 중에 누르면 학생 3명의 순서가 뒤로 밀려요.'}
        </p>
        {running ? (
          // Honest about what closing the tab does: the route keeps going to the
          // end under maxDuration=300 and bills all three images either way.
          // Staying is about SEEING the result, not about the run surviving.
          <p className="text-xs leading-relaxed text-gray-400">
            만드는 동안 이 화면을 열어 두세요. 화면을 닫아도 그림은 계속 만들어지지만, 결과를 볼 수 없어요.
          </p>
        ) : (
          samples.length > 0 && (
            <p className="text-xs leading-relaxed text-gray-400">
              이미 만들어 둔 예시가 있어요. 다시 누르면 3장을 새로 그려요.
            </p>
          )
        )}
      </div>
    </section>
  )
}
