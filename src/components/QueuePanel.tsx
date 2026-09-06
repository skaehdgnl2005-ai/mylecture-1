'use client'

import { useCallback, useEffect, useState } from 'react'
import { clsx } from 'clsx'

interface Job {
  id: string
  session_code: string
  attempt_no: number
  status: 'queued' | 'running' | 'done' | 'failed'
  tries: number
  error_code: string | null
  error_message: string | null
  created_at: string
  finished_at: string | null
  action_en: string | null
  deviceLabel: string
}

interface Pump {
  scheduled: boolean
  last_response: string | null
}

const STATUS_KO: Record<Job['status'], string> = {
  queued: '대기', running: '그리는 중', done: '완료', failed: '실패',
}

/**
 * Break-glass panel for the one afternoon something goes wrong.
 *
 * Shows the ENGLISH clause, never the student's Korean sentence: a student
 * walking past the teacher's laptop should not be able to read a classmate's
 * answer, and the English has already been stripped of names and brands.
 */
export function QueuePanel() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [pump, setPump] = useState<Pump | null>(null)
  const [busy, setBusy] = useState('')
  /** Jobs left over from lessons that are already closed — what 정리 clears. */
  const [leftovers, setLeftovers] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch('/api/teacher/queue', { cache: 'no-store' })
    if (!res.ok) return
    const d = await res.json()
    setJobs(d.jobs ?? [])
    setPump(d.pump ?? null)
    setLeftovers(d.closedLeftovers ?? 0)
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [load])

  const act = async (action: string, jobId?: string) => {
    setBusy(jobId ?? action)
    try {
      await fetch('/api/teacher/queue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, jobId }),
      })
      await load()
    } finally {
      setBusy('')
    }
  }

  const stuck = jobs.filter((j) => j.status === 'queued').length

  /**
   * 지난 수업 정리 — the button 수업 전 점검's red 대기열 row points teachers at.
   *
   * This throws away student work, so it asks first and says the number out
   * loud. It cannot touch a lesson that is open or draining (the route filters
   * on status = 'closed'), which is what makes it safe to press at 8:50am with
   * a class about to start — but the teacher has no way to know that from the
   * button, so the question says it too.
   */
  const sweep = async () => {
    if (
      !confirm(
        `지난 수업에 남아 있는 작업 ${leftovers}건을 정리할까요?\n그 그림들은 그려지지 않고 실패로 남아요. 지금 열려 있는 수업은 건드리지 않아요.`,
      )
    )
      return
    setBusy('sweep')
    setNotice(null)
    try {
      const res = await fetch('/api/teacher/queue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'sweep' }),
      })
      const d = await res.json().catch(() => ({}))
      setNotice(
        res.ok && d.ok !== false
          ? `${d.swept ?? 0}건을 정리했어요. 수업 전 점검을 다시 눌러 보세요.`
          : (d.message ?? '정리하지 못했어요.'),
      )
      await load()
    } finally {
      setBusy('')
    }
  }

  return (
    <main className="mx-auto max-w-4xl space-y-5 p-5 pb-20">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">대기열</h1>
        <a href="/teacher" className="text-sm text-brand-600">← 선생님 화면</a>
      </header>

      <section className="space-y-3 rounded-3xl bg-white p-6">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={clsx(
              'rounded-full px-3 py-1 text-sm font-semibold',
              pump?.scheduled ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700',
            )}
          >
            자동 실행 {pump?.scheduled ? '켜짐' : '꺼짐'}
          </span>
          {pump?.last_response && (
            <span className="text-sm text-gray-400">최근 응답 {pump.last_response}</span>
          )}
        </div>

        <p className="text-xs leading-relaxed text-gray-400">
          자동 실행이 꺼져 있어도 학생들이 화면을 보고 있으면 그림은 계속 그려져요.
          멈춘 것 같으면 아래 &lsquo;지금 그리기&rsquo;를 눌러 주세요.
        </p>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => act('tick')}
            disabled={busy === 'tick'}
            className="rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy === 'tick' ? '깨우는 중…' : '지금 그리기'}
          </button>
          <button
            onClick={() => act('reap')}
            disabled={busy === 'reap'}
            className="rounded-xl border-2 border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700"
          >
            멈춘 작업 되돌리기
          </button>
          <button
            onClick={sweep}
            disabled={busy === 'sweep' || leftovers === 0}
            className="rounded-xl border-2 border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 disabled:opacity-40"
          >
            {busy === 'sweep' ? '정리하는 중…' : `지난 수업 정리${leftovers > 0 ? ` (${leftovers}건)` : ''}`}
          </button>
          {stuck > 0 && (
            <span className="self-center text-sm text-amber-700">대기 {stuck}건</span>
          )}
        </div>

        {notice && (
          <div className="rounded-2xl bg-gray-50 px-4 py-3 text-sm text-gray-700">{notice}</div>
        )}

        <p className="text-xs leading-relaxed text-gray-400">
          &lsquo;지난 수업 정리&rsquo;는 이미 끝난 수업에 남은 작업만 없애요. 수업 전 점검의 대기열이
          빨간불일 때 눌러 주세요.
        </p>
      </section>

      <section className="overflow-hidden rounded-3xl bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th className="p-3">기기</th>
              <th className="p-3">상태</th>
              <th className="p-3 hidden sm:table-cell">내용 (영어)</th>
              <th className="p-3">시도</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {jobs.map((j) => (
              <tr key={j.id}>
                <td className="p-3 whitespace-nowrap">
                  {j.deviceLabel}
                  <span className="ml-1 text-xs text-gray-400">#{j.attempt_no}</span>
                </td>
                <td className="p-3">
                  <span
                    className={clsx(
                      'rounded-full px-2 py-0.5 text-xs font-semibold',
                      j.status === 'done' && 'bg-green-50 text-green-700',
                      j.status === 'failed' && 'bg-red-50 text-red-700',
                      j.status === 'running' && 'bg-blue-50 text-blue-700',
                      j.status === 'queued' && 'bg-gray-100 text-gray-600',
                    )}
                  >
                    {STATUS_KO[j.status]}
                  </span>
                  {j.error_code && (
                    <div className="mt-0.5 text-xs text-red-500">{j.error_code}</div>
                  )}
                </td>
                <td className="hidden max-w-xs truncate p-3 text-xs text-gray-500 sm:table-cell">
                  {j.action_en}
                </td>
                <td className="p-3 tabular-nums text-gray-500">{j.tries}</td>
                <td className="p-3 text-right">
                  {j.status === 'failed' && (
                    <button
                      onClick={() => act('retry', j.id)}
                      disabled={busy === j.id}
                      className="rounded-lg border-2 border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-700"
                    >
                      다시 그리기
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {jobs.length === 0 && (
              <tr>
                <td colSpan={5} className="p-8 text-center text-gray-400">
                  작업이 없어요.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </main>
  )
}
