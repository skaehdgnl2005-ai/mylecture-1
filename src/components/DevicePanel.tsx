'use client'

import { clsx } from 'clsx'
import type { DeviceUsage } from '@/lib/device-usage'

export type TeacherDevice = DeviceUsage

/**
 * 기기별 남은 횟수 (PRD §F3).
 *
 * RUNBOOK's troubleshooting table sends the teacher here for "학생 폰이
 * 초기화됨": a phone that lost its picture but kept the charged attempt. The
 * number that matters is therefore 남은 횟수, not the picture count — the two
 * disagree whenever a job is still queued, and after a reset only the first one
 * moves.
 *
 * `remaining` is computed here rather than server-side: perDeviceLimit is the
 * value the teacher just typed into the 1인당 횟수 box above, so deriving it from
 * that keeps the two numbers on screen from contradicting each other.
 *
 * Presentational only — no fetch, no confirm, no error UI. TeacherConsole owns
 * one `call()` helper that sets `busy` and paints the red notice banner, and
 * both confirms live side by side there.
 */
export function DevicePanel({
  devices,
  perDeviceLimit,
  sessionRemaining,
  busy,
  onReset,
}: {
  devices: TeacherDevice[]
  perDeviceLimit: number
  /** Attempts left under the whole-class cap. The server checks this BEFORE the
   *  per-device quota, so it is the real ceiling once it bites. */
  sessionRemaining: number
  /** TeacherConsole's `busy` string. This panel's key is `reset:${device.id}`. */
  busy: string
  onReset: (device: TeacherDevice) => void
}) {
  const capped = sessionRemaining <= 0

  return (
    <section className="space-y-4 rounded-3xl bg-white p-6">
      <h2 className="font-semibold text-gray-900">기기별 남은 횟수 ({devices.length})</h2>

      {capped && (
        <p className="rounded-2xl bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-900">
          수업 전체 상한에 도달했어요. 지금은 횟수를 되돌려도 더 그릴 수 없어요. 위 설정에서 &lsquo;수업 전체
          상한&rsquo;을 먼저 올려 주세요.
        </p>
      )}

      {devices.length === 0 ? (
        <p className="text-sm text-gray-400">아직 그림을 그린 기기가 없어요.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {devices.map((d) => {
            // The smaller of the two ceilings, because that is what the server
            // enforces: reserve_attempt() checks the session total cap as well
            // as the per-device quota, so a row promising attempts the class cap
            // will refuse would send the teacher to press a button that changes
            // nothing.
            const remaining = Math.max(0, Math.min(perDeviceLimit - d.used, sessionRemaining))
            const isBusy = busy === `reset:${d.id}`
            return (
              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                <span className="w-24 shrink-0 font-semibold text-gray-900">{d.label}</span>

                <span
                  className={clsx(
                    'rounded-full px-2.5 py-0.5 text-sm font-semibold tabular-nums',
                    remaining === 0 ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-600',
                  )}
                >
                  남은 횟수 {remaining}회
                </span>

                <span className="text-sm tabular-nums text-gray-400">그림 {d.count}장</span>

                {d.resetAt && (
                  <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-700">
                    {new Date(d.resetAt).toLocaleTimeString('ko-KR', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}{' '}
                    초기화함
                  </span>
                )}

                {/* Not disabled once resetAt is set: a phone can legitimately need
                    two resets in one lesson. The badge is advisory, and the
                    confirm gains an extra warning line instead. */}
                <button
                  onClick={() => onReset(d)}
                  disabled={isBusy}
                  aria-label={`${d.label} 횟수 초기화`}
                  className="ml-auto rounded-xl border-2 border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 disabled:opacity-50"
                >
                  {isBusy ? '초기화 중…' : '횟수 초기화'}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <p className="text-xs leading-relaxed text-gray-400">
        폰 문제로 그림을 못 받은 학생이 있으면 그 기기의 횟수를 되돌려 주세요. 이미 그린 그림은 그대로 남아요.
        기기 이름은 위 그림 목록의 이름과 같아요.
      </p>
    </section>
  )
}
