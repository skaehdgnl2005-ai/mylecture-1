'use client'

import { useState } from 'react'
import { clsx } from 'clsx'

/**
 * "수업 전 점검" (RUNBOOK 수업 전날 1번, PRD §6-2 item 7).
 *
 * Button-triggered, and there is deliberately no useEffect in this file. The
 * route calls OpenAI models.list, Supabase Storage listBuckets and four counts —
 * seconds of latency for an answer that only changes when somebody changes a
 * setting. Folding it into TeacherConsole's 4-second poll would pay that latency
 * fifteen times a minute for nothing, from a screen that is often left open on
 * a projector for the whole lesson.
 *
 * The result is cached in component state and stamped with the time it was
 * taken: the dangerous failure mode of a check screen is a green row from an
 * hour ago, so the panel always says WHEN it was green.
 */

/**
 * Mirrors GET /api/health/preflight.
 *
 * Hand-copied rather than imported: that route pulls in env/db/openai, all of
 * which are `import 'server-only'`. scripts/smoke.ts asserts this shape, so the
 * copy cannot drift unnoticed.
 */
interface Check {
  name: string
  ok: boolean
  detail: string
  /** Only rendered when ok is false — several green checks carry one too. */
  fix?: string
}

interface Preflight {
  ok: boolean
  checks: Check[]
  config: {
    imageModel: string
    quality: string
    size: string
    imagesPerMinute: number
    spacingMs: number
    maxInFlight: number
    queueOrder: string
  }
  expectations: { fortyImagesMinutes: number; note: string }
}

// Lookup-with-fallback rather than a narrow union: if IMAGE_QUALITY or
// QUEUE_ORDER ever gains a value, the panel prints the raw string instead of
// rendering a blank cell.
const QUALITY_KO: Record<string, string> = { low: '낮음', medium: '보통', high: '높음' }
const ORDER_KO: Record<string, string> = { fifo: '먼저 낸 순서', attempt_priority: '모두 1장씩 먼저' }

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-gray-400">{label}</div>
      <div className={clsx('truncate text-gray-900', mono && 'font-mono text-[13px]')}>{value}</div>
    </div>
  )
}

export function PreflightPanel({ hasActiveSession = false }: { hasActiveSession?: boolean }) {
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [data, setData] = useState<Preflight | null>(null)
  const [ranAt, setRanAt] = useState('')
  const [error, setError] = useState('')

  const running = status === 'running'
  const failed = data ? data.checks.filter((c) => !c.ok).length : 0

  const run = async () => {
    setStatus('running')
    setError('')
    try {
      const res = await fetch('/api/health/preflight', {
        cache: 'no-store',
        // The route waits on OpenAI models.list and Supabase. Without a ceiling a
        // wedged call leaves the teacher watching a spinner with nothing to act
        // on. 70s sits just past the route's own maxDuration = 60.
        signal: AbortSignal.timeout(70_000),
      })
      if (res.status === 401) {
        setError('로그인이 풀렸어요. 화면을 새로고침한 뒤 다시 점검해 주세요.')
        setStatus('error')
        return
      }
      const d = await res.json().catch(() => null)
      // A failing CHECK is still a 200 with ok:false. Only transport and auth
      // land here, so never treat !res.ok as "a check went red".
      if (!res.ok || !Array.isArray(d?.checks)) {
        setError('점검을 마치지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.')
        setStatus('error')
        return
      }
      setData(d as Preflight)
      setRanAt(new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }))
      setStatus('done')
    } catch (e) {
      setError(
        (e as Error).name === 'TimeoutError'
          ? '점검이 너무 오래 걸려요. 잠시 뒤에 다시 눌러 주세요.'
          : '점검을 마치지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.',
      )
      setStatus('error')
    }
  }

  return (
    <section className="space-y-4 rounded-3xl bg-white p-6" aria-busy={running}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-gray-900">수업 전 점검</h2>
        <button
          onClick={run}
          disabled={running}
          className="rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {running ? '점검하는 중…' : data ? '다시 점검' : '점검 시작'}
        </button>
      </div>

      <p role="status" className="sr-only">
        {running ? '점검하는 중이에요.' : data ? (data.ok ? '모두 정상이에요.' : `${failed}가지를 확인해 주세요.`) : ''}
      </p>

      {hasActiveSession && (
        <p className="text-xs leading-relaxed text-gray-400">
          수업이 열려 있을 때는 대기열이 빨간불로 보일 수 있어요. 수업 중이라면 정상이에요.
        </p>
      )}

      {status === 'idle' && (
        <>
          <p className="text-sm leading-relaxed text-gray-500">
            수업 전날 한 번 눌러 보세요. 다섯 가지가 모두 초록이면 준비가 끝난 거예요.
          </p>
          <p className="text-xs leading-relaxed text-gray-400">
            점검에는 몇 초 걸려요. 그림은 만들지 않으니 수업 예산은 줄지 않아요.
          </p>
        </>
      )}

      {error && <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

      {running && !data && (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-2xl bg-gray-100" />
          ))}
        </div>
      )}

      {data && (
        <div className={clsx('space-y-4', running && 'opacity-50')}>
          <div
            className={clsx(
              'rounded-2xl px-4 py-3 text-sm font-semibold',
              data.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-800',
            )}
          >
            {data.ok
              ? '다섯 가지가 모두 초록이에요. 이대로 수업하시면 돼요.'
              : `${failed}가지를 고쳐야 해요. 아래 빨간 안내를 따라 주세요.`}
          </div>

          <ul className="divide-y divide-gray-100">
            {data.checks.map((c) => (
              <li key={c.name} className="flex items-start gap-3 py-3">
                {/* Status is encoded twice — colour AND the words 정상/확인 필요 —
                    for the same reason Chip pairs colour with a check icon
                    (PRD §7: never colour alone). */}
                <span
                  className={clsx(
                    'shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold',
                    c.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700',
                  )}
                >
                  {c.ok ? '정상' : '확인 필요'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-gray-900">{c.name}</div>
                  {/* `detail` can be a raw Supabase/JS error string with no spaces;
                      min-w-0 + break-words stop it blowing the card out sideways at
                      360px. It is machine jargon, so it stays muted — the loud red
                      box below is the part written for the teacher. */}
                  <div className="mt-0.5 text-sm break-words text-gray-500">{c.detail}</div>
                  {!c.ok && c.fix && (
                    <p className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-sm leading-relaxed text-red-800">
                      {c.fix}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {/* The number the lesson plan is built on (RUNBOOK: 이 숫자를 수업 계획에
              쓰세요). Printed exactly as the server rounded it — re-rounding here is
              how the hero number and the note start disagreeing. */}
          <div className="rounded-2xl bg-brand-50 px-5 py-4">
            <div className="text-sm font-semibold text-brand-700">지금 설정으로 40장 그리는 시간</div>
            <div className="mt-1 flex items-baseline gap-1.5 text-brand-700">
              <span className="text-5xl font-semibold tabular-nums">
                {data.expectations.fortyImagesMinutes}
              </span>
              <span className="text-2xl font-semibold">분</span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-brand-800">{data.expectations.note}</p>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-2xl bg-gray-50 px-4 py-3 text-sm sm:grid-cols-3">
            <Field label="그림 모델" value={data.config.imageModel} mono />
            <Field label="화질" value={QUALITY_KO[data.config.quality] ?? data.config.quality} />
            <Field label="분당 한도" value={`${data.config.imagesPerMinute}장`} />
            <Field label="그림 간격" value={`${(data.config.spacingMs / 1000).toFixed(1)}초`} />
            <Field label="동시 실행" value={`${data.config.maxInFlight}개`} />
            <Field label="순서" value={ORDER_KO[data.config.queueOrder] ?? data.config.queueOrder} />
          </div>

          <p className="text-xs leading-relaxed text-gray-400">
            지금 서버에 설정된 값이에요. 새 수업을 시작하면 이 값이 그대로 복사돼요.
            <br />
            {ranAt} 기준이에요. 설정을 바꿨다면 다시 점검해 주세요.
          </p>
        </div>
      )}
    </section>
  )
}
