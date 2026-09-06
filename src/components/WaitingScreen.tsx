'use client'

import { useEffect, useState } from 'react'
import { WAITING_MESSAGES } from '@/lib/chips'

/**
 * The wait is the hard part of this product, not the queue.
 *
 * At 5 images/minute a class of 20 doing two pictures each takes ~9 minutes of
 * pure API time, and FIFO means the last student can wait most of it for their
 * FIRST picture. Nothing in the architecture can shorten that, so the screen's
 * job is to be honest and calm: a real queue position that visibly counts down,
 * a real ETA, and no fake progress bar that stalls at 90%.
 */
export function WaitingScreen({
  position,
  etaSec,
  elapsedSec,
}: {
  position: number
  etaSec: number
  elapsedSec: number
}) {
  const [msg, setMsg] = useState(0)

  useEffect(() => {
    const t = setInterval(() => setMsg((m) => (m + 1) % WAITING_MESSAGES.length), 6000)
    return () => clearInterval(t)
  }, [])

  const remaining = Math.max(0, etaSec - elapsedSec)
  const mins = Math.floor(remaining / 60)
  const secs = remaining % 60

  return (
    <div className="h-screen-safe flex flex-col items-center justify-center gap-8 px-8 text-center">
      <div className="relative h-32 w-32" aria-hidden="true">
        <div className="absolute inset-0 animate-ping rounded-full bg-brand-100 opacity-60" style={{ animationDuration: '2.4s' }} />
        <div className="absolute inset-3 rounded-full bg-brand-50" />
        <svg viewBox="0 0 48 48" className="absolute inset-0 h-full w-full p-8 text-brand-500">
          <path
            d="M8 38l10-14 7 9 5-6 10 11z M32 14a3 3 0 100 6 3 3 0 000-6z"
            fill="currentColor" opacity=".9"
          />
        </svg>
      </div>

      <div className="space-y-3">
        <h1 className="text-2xl font-semibold text-gray-900">그림을 그리고 있어요</h1>
        {position > 1 ? (
          <p className="text-lg text-gray-600">
            앞에 <span className="font-semibold text-brand-600">{position - 1}명</span> 있어요
          </p>
        ) : (
          <p className="text-lg text-gray-600">이제 곧 내 차례예요</p>
        )}
        <p className="text-[15px] text-gray-400" aria-live="polite">
          {remaining > 0
            ? `약 ${mins > 0 ? `${mins}분 ` : ''}${secs}초 남았어요`
            : '거의 다 됐어요'}
        </p>
      </div>

      <p className="min-h-[24px] text-[15px] text-gray-500 transition-opacity" aria-live="polite">
        {WAITING_MESSAGES[msg]}
      </p>

      <div className="max-w-xs rounded-2xl bg-white px-5 py-4 text-[14px] leading-relaxed text-gray-500">
        차례대로 한 장씩 그리고 있어요.
        <br />
        화면을 닫아도 그림은 계속 그려져요.
      </div>
    </div>
  )
}
