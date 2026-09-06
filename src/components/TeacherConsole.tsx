'use client'

import { useCallback, useEffect, useState } from 'react'
import Image from 'next/image'
import { clsx } from 'clsx'
import { PreflightPanel } from './PreflightPanel'
import { DevicePanel, type TeacherDevice } from './DevicePanel'
import { StyleSamplePanel } from './StyleSamplePanel'
import { STYLE_CARDS } from '@/lib/chips'
import { IMAGE_COST_USD, type ImageQuality } from '@/lib/pricing'

interface Session {
  code: string
  status: 'open' | 'draining' | 'closed'
  per_device_limit: number
  total_limit: number
  per_minute_limit: number
  allowed_styles: string[]
  image_quality: string
  queue_order: 'fifo' | 'attempt_priority'
  created_at: string
}

interface Stats {
  queued: number
  running: number
  done: number
  failed: number
  devices: number
  observedIpm: number
  estimatedCostUsd: number
  etaMinutes: number
}

interface ImageRow {
  id: string
  url: string
  tags: string[]
  is_hidden: boolean
  /** false when the STUDENT took it down. 다시 보이기 cannot undo that. */
  in_gallery: boolean
  device_id: string
  deviceLabel?: string
}

/** Same Korean words the 수업 전 점검 panel uses for the same three values. */
const QUALITIES: ReadonlyArray<{ id: ImageQuality; ko: string }> = [
  { id: 'low', ko: '낮음' },
  { id: 'medium', ko: '보통' },
  { id: 'high', ko: '높음' },
]

/** A class is 40 pictures (PRD §5-2, and the number every other screen quotes). */
const CLASS_IMAGES = 40
const forty = (q: ImageQuality) => (IMAGE_COST_USD[q] * CLASS_IMAGES).toFixed(2)

// Derived, not typed as "4": if the price table moves, the warning moves with it.
const highMultiple = Math.round(IMAGE_COST_USD.high / IMAGE_COST_USD.medium)

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'warn' | 'bad' }) {
  return (
    <div className="rounded-2xl bg-white px-4 py-3">
      <div className="text-xs text-gray-400">{label}</div>
      <div
        className={clsx(
          'mt-0.5 text-2xl font-semibold tabular-nums',
          tone === 'bad' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : 'text-gray-900',
        )}
      >
        {value}
      </div>
    </div>
  )
}

export function TeacherConsole() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [active, setActive] = useState<Session | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [images, setImages] = useState<ImageRow[]>([])
  const [devices, setDevices] = useState<TeacherDevice[]>([])
  const [qr, setQr] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [origin, setOrigin] = useState('')

  useEffect(() => setOrigin(window.location.origin), [])

  const load = useCallback(async () => {
    const res = await fetch('/api/teacher/sessions', { cache: 'no-store' })
    if (!res.ok) return
    const d = await res.json()
    setSessions(d.sessions ?? [])
    setActive(d.active ?? null)
    setStats(d.stats ?? null)

    if (d.active) {
      const [imgRes, qrRes] = await Promise.all([
        fetch(`/api/teacher/session-images?code=${d.active.code}`, { cache: 'no-store' }),
        fetch(`/api/teacher/qr?code=${d.active.code}`, { cache: 'no-store' }),
      ])
      if (imgRes.ok) {
        const d = await imgRes.json()
        setImages(d.images ?? [])
        setDevices(d.devices ?? [])
      }
      if (qrRes.ok) setQr(await qrRes.text())
    } else {
      setImages([])
      setDevices([])
      setQr(null)
    }
  }, [])

  // 4-second dashboard refresh.
  //
  // This poll does NOT wake the worker. kickWorker() is called from POST
  // /api/jobs, GET /api/jobs/[id] and the 대기열 screen's '지금 그리기' button —
  // and nowhere else. The comment here used to claim otherwise; the code was
  // right and the comment was wrong.
  useEffect(() => {
    load()
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [load])

  const call = async (fn: () => Promise<Response>, label: string) => {
    setBusy(label)
    setNotice(null)
    try {
      const res = await fn()
      const d = await res.json().catch(() => ({}))
      if (!res.ok || d.ok === false) setNotice(d.message ?? '실패했어요.')
      await load()
    } finally {
      setBusy('')
    }
  }

  const newSession = () =>
    call(() => fetch('/api/teacher/sessions', { method: 'POST' }), 'new')

  // 'draining', never straight to 'closed'.
  //
  // The worker's tick() returns immediately when no session is open or draining,
  // so closing outright abandons every picture still in the queue — and at
  // 5 images a minute there are almost always several, because the teacher
  // closes the lesson while the last students are still waiting. Draining stops
  // NEW submissions (POST /api/jobs requires 'open') and lets the queue finish;
  // the worker flips it to 'closed' when nothing is left.
  const closeSession = () => {
    if (!active) return
    const pending = (stats?.queued ?? 0) + (stats?.running ?? 0)
    if (
      pending > 0 &&
      !confirm(
        `아직 그리는 중인 그림이 ${pending}장 있어요.\n수업을 닫으면 새 그림은 못 그리지만, 이 ${pending}장은 끝까지 그려요. 닫을까요?`,
      )
    )
      return
    call(
      () =>
        fetch(`/api/teacher/sessions/${active.code}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'draining' }),
        }),
      'close',
    )
  }

  const patch = (body: Record<string, unknown>) =>
    active &&
    call(
      () =>
        fetch(`/api/teacher/sessions/${active.code}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      'patch',
    )

  // ── 사용 가능 스타일 ────────────────────────────────────────────────────────
  // Rebuilt in STYLE_CARDS order rather than by appending, so the array the
  // students' step 5 renders from keeps a stable order across toggles.
  const toggleStyle = (id: string) => {
    if (!active) return
    const on = active.allowed_styles.includes(id)
    const next = STYLE_CARDS.filter((s) => (s.id === id ? !on : active.allowed_styles.includes(s.id))).map(
      (s) => s.id,
    )
    // The PATCH schema is .min(1). Refusing here — rather than letting the
    // server 400 — is the difference between "you have to keep one" and "the
    // app is broken", five minutes before a lesson.
    if (next.length === 0) {
      setNotice('그림은 하나 이상 켜 두어야 해요.')
      return
    }
    // Turning one OFF during a live lesson bounces students who already picked
    // it, so say so first. Turning one back ON costs nobody anything.
    if (on && active.status === 'open') {
      const label = STYLE_CARDS.find((s) => s.id === id)?.ko ?? id
      if (
        !confirm(
          `'${label}'을(를) 끌까요?\n이 그림을 이미 고른 학생은 '그림 그리기'를 누를 때 다시 고르라는 안내를 받아요. 답변은 지워지지 않아요.`,
        )
      )
        return
    }
    patch({ allowedStyles: next })
  }

  // ── 화질 ───────────────────────────────────────────────────────────────────
  // The only setting on this screen that multiplies the bill, so 높음 is the
  // one that asks. The numbers come from the price table, not from prose.
  const setQuality = (q: ImageQuality) => {
    if (!active || active.image_quality === q) return
    if (
      q === 'high' &&
      !confirm(
        `그림 한 장이 $${IMAGE_COST_USD.medium.toFixed(3)} 에서 $${IMAGE_COST_USD.high.toFixed(3)} 로, 약 ${highMultiple}배가 돼요.\n${CLASS_IMAGES}장이면 약 $${forty('medium')} 에서 약 $${forty('high')} 예요. 높음으로 바꿀까요?`,
      )
    )
      return
    patch({ imageQuality: q })
  }

  const toggleHide = (img: ImageRow) =>
    call(
      () =>
        fetch(`/api/teacher/images/${img.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ isHidden: !img.is_hidden }),
        }),
      img.id,
    )

  // ── 기기 횟수 초기화 (PRD §F3) ──────────────────────────────────────────────
  // A lighter confirm than deleteSession's two-step. This hands a student extra
  // image budget — a cost decision, and one the session total cap still bounds —
  // but it destroys nothing, so one question is the right amount of friction.
  // Typing the code is reserved for the irreversible action.
  const resetDevice = (d: TeacherDevice) => {
    if (!active) return
    const again = d.resetAt ? '이미 한 번 초기화한 기기예요.\n' : ''
    // Promise the number the SERVER will actually honour: the session total cap
    // is checked before the per-device quota, so it can be the smaller of the two.
    const grant = Math.max(0, Math.min(active.per_device_limit, sessionRemaining))
    const body =
      grant === 0
        ? '수업 전체 상한에 도달해서, 지금은 되돌려도 더 그릴 수 없어요. 그래도 되돌릴까요?'
        : `이 기기가 그림을 ${grant}번 더 그릴 수 있어요.`
    if (!confirm(`${again}'${d.label}'의 횟수를 되돌릴까요?\n${body}`)) return
    call(
      () =>
        fetch(`/api/teacher/devices/${d.id}/reset`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionCode: active.code }),
        }),
      `reset:${d.id}`,
    )
  }

  const deleteSession = async (code: string) => {
    // Two-step confirm (PRD §F4): the second step requires typing the code, so
    // a mis-click cannot delete a class's work.
    if (!confirm(`'${code}' 세션의 그림을 모두 지울까요?\n지우기 전에 ZIP으로 내려받는 것을 권해요.`)) return
    const typed = prompt(`정말 지우려면 세션 코드 '${code}' 를 입력해 주세요.`)
    if (typed !== code) return
    await call(
      () =>
        fetch(`/api/teacher/sessions/${code}`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirm: code }),
        }),
      'delete',
    )
  }

  const joinUrl = active && origin ? `${origin}/s/${active.code}` : ''

  // The same arithmetic reserve_attempt() does: jobs in queued/running/done count
  // against total_limit, and that check runs BEFORE the per-device quota.
  const sessionRemaining = active
    ? Math.max(0, active.total_limit - ((stats?.queued ?? 0) + (stats?.running ?? 0) + (stats?.done ?? 0)))
    : 0

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-5 pb-20">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">선생님 화면</h1>
        <div className="flex gap-2">
          <a href="/teacher/queue" className="rounded-xl border-2 border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700">
            대기열
          </a>
          <button
            onClick={() => fetch('/api/teacher/logout', { method: 'POST' }).then(() => location.reload())}
            className="rounded-xl border-2 border-gray-200 bg-white px-4 py-2 text-sm text-gray-500"
          >
            나가기
          </button>
        </div>
      </header>

      {notice && <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">{notice}</div>}

      {!active ? (
        <div className="space-y-4 rounded-3xl bg-white p-8 text-center">
          <p className="text-gray-500">지금 열려 있는 수업이 없어요.</p>
          <button
            onClick={newSession}
            disabled={busy === 'new'}
            className="h-14 rounded-2xl bg-brand-500 px-8 text-lg font-semibold text-white disabled:opacity-50"
          >
            {busy === 'new' ? '만드는 중…' : '새 수업 시작'}
          </button>
          <p className="text-xs text-gray-400">새 수업을 시작하면 이전 수업은 자동으로 닫혀요.</p>
        </div>
      ) : (
        <>
          <section className="grid gap-5 rounded-3xl bg-white p-6 sm:grid-cols-[auto_1fr]">
            <div className="flex flex-col items-center gap-3">
              {qr && (
                <div
                  className="h-44 w-44 [&_svg]:h-full [&_svg]:w-full"
                  dangerouslySetInnerHTML={{ __html: qr }}
                />
              )}
              <div className="text-center">
                <div className="font-mono text-4xl font-semibold tracking-[0.25em] text-gray-900">
                  {active.code}
                </div>
                <div className="mt-1 text-xs break-all text-gray-400">{joinUrl}</div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="완료" value={stats?.done ?? 0} />
                <Stat label="대기" value={stats?.queued ?? 0} tone={(stats?.queued ?? 0) > 0 ? 'warn' : undefined} />
                <Stat label="그리는 중" value={stats?.running ?? 0} />
                <Stat label="실패" value={stats?.failed ?? 0} tone={(stats?.failed ?? 0) > 0 ? 'bad' : undefined} />
                <Stat label="참여 기기" value={stats?.devices ?? 0} />
                <Stat label="분당 실제" value={`${stats?.observedIpm ?? 0}장`} />
                <Stat label="남은 시간" value={`${stats?.etaMinutes ?? 0}분`} />
                <Stat label="예상 비용" value={`$${stats?.estimatedCostUsd ?? 0}`} />
              </div>

              <div className="flex flex-wrap gap-2">
                <a
                  href={`/g/${active.code}`}
                  target="_blank"
                  className="rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white"
                >
                  갤러리 열기
                </a>
                <a
                  href={`/g/${active.code}?projector=1`}
                  target="_blank"
                  className="rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white"
                >
                  프로젝터 모드
                </a>
                <a
                  href={`/api/teacher/sessions/${active.code}/zip`}
                  className="rounded-xl border-2 border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700"
                >
                  ZIP 내려받기
                </a>
                <button
                  onClick={closeSession}
                  disabled={busy === 'close' || active.status === 'draining'}
                  className="rounded-xl border-2 border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 disabled:opacity-50"
                >
                  수업 닫기
                </button>
              </div>

              {active.status === 'draining' && (
                <div className="rounded-2xl bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-900">
                  수업을 닫았어요. 새 그림은 받지 않고, 남은{' '}
                  {(stats?.queued ?? 0) + (stats?.running ?? 0)}장을 마저 그리는 중이에요. 다 그리면 저절로
                  끝나요.
                </div>
              )}
            </div>
          </section>

          <section className="space-y-4 rounded-3xl bg-white p-6">
            <h2 className="font-semibold text-gray-900">설정</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="space-y-1.5">
                <span className="text-sm text-gray-500">1인당 횟수</span>
                <input
                  type="number" min={1} max={10} defaultValue={active.per_device_limit}
                  onBlur={(e) => patch({ perDeviceLimit: Number(e.target.value) })}
                  className="w-full rounded-xl border-2 border-gray-200 p-2.5"
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-sm text-gray-500">수업 전체 상한</span>
                <input
                  type="number" min={1} max={500} defaultValue={active.total_limit}
                  onBlur={(e) => patch({ totalLimit: Number(e.target.value) })}
                  className="w-full rounded-xl border-2 border-gray-200 p-2.5"
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-sm text-gray-500">순서</span>
                <select
                  defaultValue={active.queue_order}
                  onChange={(e) => patch({ queueOrder: e.target.value })}
                  className="w-full rounded-xl border-2 border-gray-200 bg-white p-2.5"
                >
                  <option value="fifo">먼저 낸 순서 (FIFO)</option>
                  <option value="attempt_priority">모두 1장씩 먼저</option>
                </select>
              </label>
            </div>
            <p className="text-xs leading-relaxed text-gray-400">
              &lsquo;모두 1장씩 먼저&rsquo;로 바꾸면 마지막 학생이 첫 그림을 받는 시간이 약 9분에서 약 5분으로 줄어요.
              전체가 끝나는 시간은 같아요.
            </p>

            {/* ── 사용 가능 스타일 (PRD §F4) ─────────────────────────────────
                Labels come from STYLE_CARDS, never hand-typed: chips.test.ts
                pins that list to the server's prompt dictionary, so a style
                renamed in one place cannot end up renamed only here. ── */}
            <div className="space-y-2 border-t border-gray-100 pt-4">
              <span className="text-sm text-gray-500">학생이 고를 수 있는 그림</span>
              <div className="flex flex-wrap gap-2">
                {STYLE_CARDS.map((s) => {
                  const on = active.allowed_styles.includes(s.id)
                  const last = on && active.allowed_styles.length === 1
                  return (
                    <button
                      key={s.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleStyle(s.id)}
                      disabled={busy === 'patch'}
                      className={clsx(
                        'rounded-xl border-2 px-4 py-2.5 text-sm font-semibold',
                        on ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-gray-200 text-gray-500',
                        last && 'opacity-70',
                      )}
                    >
                      {on ? '✓ ' : ''}
                      {s.ko}
                    </button>
                  )
                })}
              </div>
              <p className="text-xs leading-relaxed text-gray-400">
                끄면 새로 들어오는 학생에게는 그 그림이 안 보여요. 이미 그 그림을 고른 학생은
                &lsquo;그림 그리기&rsquo;를 누를 때 다시 고르라는 안내를 받고, 답변은 그대로 남아요.
                하나는 켜 두어야 해요.
              </p>
            </div>

            {/* ── 화질 ──────────────────────────────────────────────────────
                The price is printed ON the buttons. 높음 costs about four
                times 보통, and a teacher who finds that out from the invoice
                found out too late — so the number is never more than one
                glance from the control that changes it. ── */}
            <div className="space-y-2 border-t border-gray-100 pt-4">
              <span className="text-sm text-gray-500">화질</span>
              <div className="grid gap-2 sm:grid-cols-3">
                {QUALITIES.map((q) => {
                  const on = active.image_quality === q.id
                  return (
                    <button
                      key={q.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setQuality(q.id)}
                      disabled={busy === 'patch'}
                      className={clsx(
                        'rounded-xl border-2 px-4 py-2.5 text-left',
                        on ? 'border-brand-500 bg-brand-50' : 'border-gray-200',
                      )}
                    >
                      <div className={clsx('text-sm font-semibold', on ? 'text-brand-700' : 'text-gray-700')}>
                        {on ? '✓ ' : ''}
                        {q.ko}
                      </div>
                      <div className="mt-0.5 text-xs tabular-nums text-gray-500">
                        장당 ${IMAGE_COST_USD[q.id].toFixed(3)} · 40장 ${forty(q.id)}
                      </div>
                      {q.id === 'high' && (
                        <div className="mt-0.5 text-xs font-semibold text-red-600">
                          보통의 약 {highMultiple}배
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
              <p className="text-xs leading-relaxed text-gray-400">
                지금 그리는 중인 그림은 원래 화질로 끝나고, 대기 중인 그림부터 새 화질로 그려요.
                <br />
                화질을 낮춰도 빨라지지는 않아요 — 분당 한도가 장수 기준이라서요.
              </p>
            </div>
          </section>

          <section className="space-y-4 rounded-3xl bg-white p-6">
            <h2 className="font-semibold text-gray-900">그림 ({images.length})</h2>
            {images.length === 0 ? (
              <p className="text-sm text-gray-400">아직 그림이 없어요.</p>
            ) : (
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
                {images.map((img) => (
                  <div key={img.id} className="space-y-1.5">
                    <div className={clsx('overflow-hidden rounded-xl bg-gray-100', img.is_hidden && 'opacity-40')}>
                      <Image src={img.url} alt="" width={512} height={768} quality={75} className="aspect-[2/3] w-full object-cover" />
                    </div>
                    <div className="truncate text-[11px] text-gray-400">{img.deviceLabel}</div>
                    {/* A student can take their own picture down from the gallery
                        screen. Without this line the teacher sees a picture that
                        is not on the wall and no reason why — and pressing
                        다시 보이기 would not put it back, because that button only
                        clears is_hidden. */}
                    {!img.is_hidden && !img.in_gallery && (
                      <div className="text-[11px] text-amber-700">학생이 내렸어요</div>
                    )}
                    <button
                      onClick={() => toggleHide(img)}
                      disabled={busy === img.id}
                      className={clsx(
                        'w-full rounded-lg py-1.5 text-xs font-semibold',
                        img.is_hidden ? 'bg-gray-900 text-white' : 'border-2 border-gray-200 text-gray-600',
                      )}
                    >
                      {img.is_hidden ? '다시 보이기' : '숨기기'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── 기기 횟수 초기화 (PRD §F3) — under the picture grid because the
              teacher identifies a phone by matching its picture above. ── */}
          <DevicePanel
            devices={devices}
            perDeviceLimit={active.per_device_limit}
            sessionRemaining={sessionRemaining}
            busy={busy}
            onReset={resetDevice}
          />
        </>
      )}

      {/* Both panels sit OUTSIDE the active/inactive branch on purpose.
          The pre-class check and the style samples are day-before work, done when
          no session exists — and a stable position in the children array means a
          session opening or closing mid-run cannot remount them. */}
      <PreflightPanel hasActiveSession={!!active} />

      {/* `!!active`, not a status check: GET /api/teacher/sessions picks `active`
          as the first row whose status is 'open' or 'draining', so re-testing the
          status here would be a branch that can never be false. */}
      <StyleSamplePanel
        sessionOpen={!!active}
        pendingJobs={(stats?.queued ?? 0) + (stats?.running ?? 0)}
      />

      <section className="space-y-3 rounded-3xl bg-white p-6">
        <h2 className="font-semibold text-gray-900">지난 수업</h2>
        {sessions.filter((s) => s.status === 'closed').length === 0 ? (
          <p className="text-sm text-gray-400">아직 없어요.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {sessions
              .filter((s) => s.status === 'closed')
              .map((s) => (
                <li key={s.code} className="flex items-center justify-between py-3">
                  <span className="font-mono font-semibold tracking-widest">{s.code}</span>
                  <span className="flex gap-2 text-sm">
                    <a href={`/g/${s.code}`} target="_blank" className="text-brand-600">갤러리</a>
                    <a href={`/api/teacher/sessions/${s.code}/zip`} className="text-brand-600">ZIP</a>
                    <button onClick={() => deleteSession(s.code)} className="text-red-500">삭제</button>
                  </span>
                </li>
              ))}
          </ul>
        )}
        <p className="text-xs text-gray-400">
          그림은 저절로 지워지지 않아요. 지우기 전에 ZIP으로 내려받아 주세요.
        </p>
      </section>
    </main>
  )
}
