'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getDeviceId, newIdempotencyKey } from '@/lib/device'
import { StepForm, type FormValue } from './StepForm'
import { WaitingScreen } from './WaitingScreen'
import { ResultScreen } from './ResultScreen'
import { PrimaryButton } from './ui'

type Phase = 'loading' | 'form' | 'waiting' | 'result' | 'blocked'

interface JoinInfo {
  allowedStyles: string[]
  perDeviceLimit: number
  status: string
  used: number
  remaining: number
}

export function StudentApp({
  code,
  styleSamples,
}: {
  code: string
  styleSamples: Record<string, string | null>
}) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('loading')
  const [info, setInfo] = useState<JoinInfo | null>(null)
  const [blockedMsg, setBlockedMsg] = useState('')
  const [error, setError] = useState<{ field: 1 | 2 | null; message: string; helpline?: boolean } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [jobId, setJobId] = useState<string | null>(null)
  const [position, setPosition] = useState(1)
  const [etaSec, setEtaSec] = useState(60)
  const [elapsed, setElapsed] = useState(0)
  const [result, setResult] = useState<{ imageId: string; imageUrl: string; tags: string[]; inGallery: boolean } | null>(null)

  const deviceId = useRef<string>('')
  // Minted once per attempt so a double-tap, a retried fetch, or flaky wifi
  // cannot turn one tap into two jobs.
  const idemKey = useRef<string>('')
  const pollMs = useRef(2500)

  // ── join ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    deviceId.current = getDeviceId()
    ;(async () => {
      const res = await fetch('/api/session/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, deviceId: deviceId.current }),
      })
      const data = await res.json()
      if (!data.ok) {
        setBlockedMsg(data.message ?? '지금은 들어갈 수 없어요.')
        setPhase('blocked')
        return
      }
      pollMs.current = data.pollIntervalMs ?? 2500
      setInfo({
        allowedStyles: data.session.allowedStyles,
        perDeviceLimit: data.session.perDeviceLimit,
        status: data.session.status,
        used: data.usage.used,
        remaining: data.usage.remaining,
      })
      if (data.usage.remaining <= 0) {
        setBlockedMsg('그림을 모두 그렸어요. 친구들 그림을 구경해 볼까요?')
        setPhase('blocked')
      } else {
        idemKey.current = newIdempotencyKey()
        setPhase('form')
      }
    })().catch(() => {
      setBlockedMsg('연결이 잘 안 돼요. 잠시 뒤 다시 열어 주세요.')
      setPhase('blocked')
    })
  }, [code])

  // ── poll ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'waiting' || !jobId) return
    let stop = false
    const startedAt = Date.now()

    const tick = async () => {
      if (stop) return
      setElapsed(Math.round((Date.now() - startedAt) / 1000))
      try {
        const res = await fetch(
          `/api/jobs/${jobId}?deviceId=${encodeURIComponent(deviceId.current)}`,
          { cache: 'no-store' },
        )
        const d = await res.json()

        if (d.status === 'done') {
          stop = true
          setResult({ imageId: d.imageId, imageUrl: d.imageUrl, tags: d.tags ?? [], inGallery: d.inGallery ?? true })
          setInfo((p) => (p ? { ...p, used: p.used + 1, remaining: Math.max(0, p.remaining - 1) } : p))
          setPhase('result')
          return
        }
        if (d.status === 'failed') {
          stop = true
          // The attempt was never consumed, so send them back to the form with
          // a fresh idempotency key rather than to a dead end.
          idemKey.current = newIdempotencyKey()
          setError({ field: d.errorCode === 'moderation_input' ? 1 : null, message: d.message })
          setPhase('form')
          return
        }
        if (typeof d.position === 'number') setPosition(d.position)
        if (typeof d.etaSec === 'number') setEtaSec(d.etaSec)
        if (typeof d.pollIntervalMs === 'number') pollMs.current = d.pollIntervalMs
      } catch {
        /* keep polling: a dropped poll on school wifi is normal */
      }
      if (!stop) setTimeout(tick, pollMs.current)
    }

    const t = setTimeout(tick, 400)
    return () => {
      stop = true
      clearTimeout(t)
    }
  }, [phase, jobId])

  // ── submit ────────────────────────────────────────────────────────────────
  const submit = useCallback(
    async (v: FormValue) => {
      setSubmitting(true)
      setError(null)
      try {
        const res = await fetch('/api/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...v, code, deviceId: deviceId.current, idempotencyKey: idemKey.current }),
        })
        const d = await res.json()

        if (d.ok) {
          setJobId(d.jobId)
          setPosition(1)
          setElapsed(0)
          setPhase('waiting')
          return
        }
        if (d.reason === 'quota' || d.reason === 'session_cap') {
          setBlockedMsg(d.message)
          setPhase('blocked')
          return
        }
        // A safety rejection. The attempt was NOT consumed and no job row was
        // ever created, so the student simply edits and tries again.
        setError({ field: d.field ?? null, message: d.message, helpline: d.helpline })
      } catch {
        setError({ field: null, message: '연결이 잘 안 돼요. 다시 한 번 눌러 주세요.' })
      } finally {
        setSubmitting(false)
      }
    },
    [code],
  )

  const toggleGallery = async (next: boolean) => {
    if (!result) return
    setResult({ ...result, inGallery: next })
    if (!next) {
      await fetch(`/api/gallery/image/${result.imageId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: deviceId.current }),
      }).catch(() => {})
    }
  }

  if (phase === 'loading') {
    return (
      <div className="h-screen-safe flex items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-3 border-gray-200 border-t-brand-500" />
      </div>
    )
  }

  if (phase === 'blocked') {
    return (
      <div className="h-screen-safe flex flex-col items-center justify-center gap-6 px-8 text-center">
        <p className="text-lg leading-relaxed whitespace-pre-line text-gray-700">{blockedMsg}</p>
        <div className="w-full max-w-xs">
          <PrimaryButton onClick={() => router.push(`/g/${code}`)}>친구들 그림 보기</PrimaryButton>
        </div>
      </div>
    )
  }

  if (phase === 'waiting') {
    return <WaitingScreen position={position} etaSec={etaSec} elapsedSec={elapsed} />
  }

  if (phase === 'result' && result) {
    return (
      <ResultScreen
        imageId={result.imageId}
        imageUrl={result.imageUrl}
        tags={result.tags}
        inGallery={result.inGallery}
        remaining={info?.remaining ?? 0}
        onToggleGallery={toggleGallery}
        onRedraw={() => {
          idemKey.current = newIdempotencyKey()
          setResult(null)
          setJobId(null)
          setPhase('form')
        }}
        onOpenGallery={() => router.push(`/g/${code}`)}
      />
    )
  }

  return (
    <StepForm
      allowedStyles={info?.allowedStyles ?? ['anime', 'photo', 'watercolor']}
      styleSamples={styleSamples}
      onSubmit={submit}
      submitting={submitting}
      error={error}
    />
  )
}
