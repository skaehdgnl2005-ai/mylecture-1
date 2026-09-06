'use client'

import { useCallback, useEffect, useState } from 'react'
import Image from 'next/image'
import { clsx } from 'clsx'

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
  device_id: string
  deviceLabel?: string
}

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
      if (imgRes.ok) setImages((await imgRes.json()).images ?? [])
      if (qrRes.ok) setQr(await qrRes.text())
    } else {
      setImages([])
      setQr(null)
    }
  }, [])

  // The dashboard poll doubles as a tertiary worker pump.
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

  const closeSession = () =>
    active &&
    call(
      () =>
        fetch(`/api/teacher/sessions/${active.code}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'closed' }),
        }),
      'close',
    )

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
                  disabled={busy === 'close'}
                  className="rounded-xl border-2 border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700"
                >
                  수업 닫기
                </button>
              </div>
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
        </>
      )}

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
