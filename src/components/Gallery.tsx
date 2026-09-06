'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Image from 'next/image'
import { clsx } from 'clsx'
import { peekDeviceId } from '@/lib/device'

export interface GalleryItem {
  id: string
  url: string
  tags: string[]
}

/** One row of POST /api/gallery/[code]/mine. */
export interface OwnedImage {
  id: string
  url: string
  inGallery: boolean
}

/**
 * Polls the gallery route, which returns ONLY id/url/tags.
 *
 * Polling rather than Supabase Realtime is a privacy decision, not a scale one:
 * `postgres_changes` authorises per subscriber, so it would require opening
 * public.images to the anon role and hand-maintaining column grants to keep
 * created_at and the free-text sentence from leaking through PostgREST. Here the
 * server picks the columns, once, in a place a reviewer can read.
 */
function useGallery(code: string) {
  const [items, setItems] = useState<GalleryItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const etag = useRef<string | null>(null)
  const intervalMs = useRef(5000)

  useEffect(() => {
    let stop = false
    const poll = async () => {
      if (stop) return
      try {
        const res = await fetch(`/api/gallery/${code}`, {
          headers: etag.current ? { 'if-none-match': etag.current } : undefined,
          cache: 'no-store',
        })
        if (res.status !== 304) {
          const tag = res.headers.get('etag')
          if (tag) etag.current = tag
          const d = await res.json()
          if (!stop && Array.isArray(d.items)) {
            setItems(d.items)
            if (typeof d.pollIntervalMs === 'number') intervalMs.current = d.pollIntervalMs
          }
        }
      } catch {
        /* keep polling */
      }
      if (!stop) {
        setLoaded(true)
        setTimeout(poll, intervalMs.current)
      }
    }
    poll()
    return () => {
      stop = true
    }
  }, [code])

  return { items, loaded }
}

/**
 * The student's own pictures, and the only place they can be taken down or put
 * back (PRD §F2).
 *
 * Separate from the gallery poll on purpose: /api/gallery/[code] returns exactly
 * (id, url, tags) and its ETag is shared by every phone in the room, so
 * ownership cannot ride along without turning a room full of 304s into full
 * responses. This asks a second, low-frequency question instead — on mount, and
 * on refocus if the answer is more than 30 seconds old (a student draws a second
 * picture, comes back, and expects to see two).
 */
function useOwnedImages(code: string, enabled: boolean) {
  const [owned, setOwned] = useState<OwnedImage[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const deviceId = useRef<string | null>(null)
  const lastFetch = useRef(0)
  const noticeT = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showNotice = useCallback((text: string) => {
    if (noticeT.current) clearTimeout(noticeT.current)
    setNotice(text)
    // 6s outlives one 5s gallery poll, so the note is still on screen when the
    // thing it describes actually happens.
    noticeT.current = setTimeout(() => setNotice(null), 6000)
  }, [])

  const refresh = useCallback(async () => {
    if (!deviceId.current) return
    try {
      const res = await fetch(`/api/gallery/${code}/mine`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: deviceId.current }),
        cache: 'no-store',
      })
      if (!res.ok) return // keep whatever we already had
      const d = await res.json()
      if (Array.isArray(d.items)) {
        setOwned(d.items)
        lastFetch.current = Date.now()
      }
    } catch {
      /* offline: keep the strip we already drew */
    }
  }, [code])

  useEffect(() => {
    // Projector mode passes enabled=false, so it never reads the device id and
    // never issues a request — the teacher's laptop stays anonymous.
    if (!enabled) return
    deviceId.current = peekDeviceId()
    if (deviceId.current) void refresh()

    // The listener is registered even with no identity yet. A student can open
    // the gallery link first, join and draw in another tab, then come back — the
    // id exists by then, so re-read it here rather than only at mount.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (!deviceId.current) deviceId.current = peekDeviceId()
      if (deviceId.current && Date.now() - lastFetch.current > 30_000) void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [enabled, refresh])

  useEffect(() => () => {
    if (noticeT.current) clearTimeout(noticeT.current)
  }, [])

  const setInGallery = useCallback(
    async (id: string, next: boolean) => {
      // One at a time. MyPictures disables EVERY button while this is set, so a
      // tap on another row is visibly refused rather than silently dropped.
      if (busyId) return
      setBusyId(id)
      // Optimistic: the row has to change under the thumb, not after a round trip.
      setOwned((prev) => prev.map((o) => (o.id === id ? { ...o, inGallery: next } : o)))
      try {
        const res = await fetch(`/api/gallery/image/${id}`, {
          method: next ? 'PUT' : 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deviceId: deviceId.current }),
        })
        if (res.status === 404) {
          // The only way to reach this: the teacher hid the picture while the
          // strip was on screen, so 다시 올리기 can no longer do what it says.
          // Re-read instead of showing "try again" — the row then disappears the
          // same way the gallery card did, and the student is never told a
          // teacher hid their picture.
          await refresh()
          return
        }
        if (!res.ok) throw new Error(String(res.status))
        // The card only comes BACK on the next 5s poll, so say so — otherwise it
        // reads as "I pressed it and nothing happened". Taking it DOWN needs no
        // notice: the grid card dims immediately, which is the feedback.
        if (next) showNotice('다시 올렸어요. 잠시 뒤 아래에 나타나요.')
        // Awaited, not fire-and-forget: releasing the lock first would let a
        // second tap start while this response is still in flight, and the two
        // could land out of order.
        await refresh()
      } catch {
        setOwned((prev) => prev.map((o) => (o.id === id ? { ...o, inGallery: !next } : o)))
        showNotice('잠깐 안 됐어요. 다시 눌러 주세요.')
      } finally {
        setBusyId(null)
      }
    },
    [busyId, refresh, showNotice],
  )

  const ownedById = useMemo(() => new Map(owned.map((o) => [o.id, o])), [owned])

  return { owned, ownedById, busyId, notice, setInGallery }
}

function MyPictures({
  owned,
  busyId,
  notice,
  onSetInGallery,
}: {
  owned: OwnedImage[]
  busyId: string | null
  notice: string | null
  onSetInGallery: (id: string, next: boolean) => void
}) {
  if (owned.length === 0) return null

  return (
    <section className="px-4 pb-4">
      <div className="rounded-3xl bg-white p-4">
        <h2 className="text-[15px] font-semibold text-gray-900">내 그림</h2>
        <p className="mt-0.5 text-[13px] text-gray-400">내가 그린 그림만 내리거나 다시 올릴 수 있어요.</p>
        <ul className="mt-3 space-y-2.5">
          {owned.map((o) => (
            <li key={o.id} className="flex items-center gap-3">
              <div
                className={clsx(
                  'shrink-0 overflow-hidden rounded-xl bg-gray-100',
                  !o.inGallery && 'opacity-40 grayscale',
                )}
              >
                {/* Same width/quality/sizes as the grid on purpose: the browser
                    reuses the already-cached /_next/image response, so the strip
                    costs no extra egress. */}
                <Image
                  src={o.url}
                  alt=""
                  width={512}
                  height={768}
                  quality={75}
                  sizes="(max-width: 640px) 50vw, 256px"
                  className="h-16 w-11 object-cover"
                />
              </div>
              <span className="flex-1 text-[13px] text-gray-500">
                {o.inGallery ? '올라가 있어요' : '내려뒀어요'}
              </span>
              {/* Disabled while ANY row is in flight, not just this one: the hook
                  serialises requests, so a per-row disable would let a tap on a
                  second row be swallowed with no feedback at all. */}
              <button
                disabled={busyId !== null}
                onClick={() => onSetInGallery(o.id, !o.inGallery)}
                className={clsx(
                  'h-11 shrink-0 rounded-xl px-4 text-sm font-semibold transition-colors',
                  o.inGallery
                    ? 'border-2 border-gray-200 bg-white text-gray-700 active:bg-gray-50'
                    : 'bg-brand-500 text-white active:bg-brand-600',
                  busyId !== null && 'opacity-50',
                )}
              >
                {o.inGallery ? '내리기' : '다시 올리기'}
              </button>
            </li>
          ))}
        </ul>
        {notice && (
          <p className="mt-3 rounded-2xl bg-amber-50 px-3.5 py-2.5 text-[13px] leading-relaxed text-amber-900">
            {notice}
          </p>
        )}
      </div>
    </section>
  )
}

/**
 * Fullscreen viewer: CSS scroll-snap plus IntersectionObserver for the index.
 * Zero dependencies, native momentum. `scrollend` only reached Baseline in
 * December 2025, so the observer is what tracks position.
 */
function Lightbox({
  items,
  startIndex,
  onClose,
  ownedIds,
}: {
  items: GalleryItem[]
  startIndex: number
  onClose: () => void
  /** Identification only. The take-down action is deliberately NOT here — the
   *  bottom bar is exactly where the thumb rests to swipe, and removing an item
   *  would change items.length under a scroll-snap track whose index is tracked
   *  by IntersectionObserver, making the view jump. */
  ownedIds: Set<string>
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(startIndex)

  useEffect(() => {
    const el = trackRef.current?.children[startIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [startIndex])

  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const i = Number((e.target as HTMLElement).dataset.index)
            if (!Number.isNaN(i)) setIndex(i)
          }
        }
      },
      { root: track, threshold: 0.6 },
    )
    for (const child of Array.from(track.children)) io.observe(child)
    return () => io.disconnect()
  }, [items.length])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="pt-safe flex items-center justify-between px-4 py-3 text-white/80">
        <div className="flex items-center gap-2">
          <span className="text-sm tabular-nums">
            {index + 1} / {items.length}
          </span>
          {items[index] && ownedIds.has(items[index].id) && (
            <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-[12px] font-semibold text-white">
              내 그림
            </span>
          )}
        </div>
        <button onClick={onClose} aria-label="닫기" className="flex h-11 w-11 items-center justify-center rounded-full active:bg-white/10">
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div
        ref={trackRef}
        className="flex flex-1 snap-x snap-mandatory overflow-x-auto overscroll-x-contain"
        style={{ scrollbarWidth: 'none' }}
      >
        {items.map((item, i) => (
          <div
            key={item.id}
            data-index={i}
            className="flex w-full shrink-0 snap-center snap-always flex-col items-center justify-center px-4"
          >
            {/* Full size here — the grid uses thumbnails, this is the one place
                the original is worth the bytes. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={item.url} alt="" className="max-h-full max-w-full object-contain" loading="lazy" />
          </div>
        ))}
      </div>

      <div className="pb-safe flex flex-wrap justify-center gap-1.5 px-4 py-3">
        {items[index]?.tags.map((t) => (
          <span key={t} className="rounded-full bg-white/10 px-3 py-1 text-[13px] text-white/70">
            {t}
          </span>
        ))}
      </div>
    </div>
  )
}

export function Gallery({ code, projector = false }: { code: string; projector?: boolean }) {
  const { items, loaded } = useGallery(code)
  const [open, setOpen] = useState<number | null>(null)
  const [slide, setSlide] = useState(0)
  // Hooks cannot be called conditionally, so the projector branch below disables
  // this by flag rather than by skipping the call.
  const { owned, ownedById, busyId, notice, setInGallery } = useOwnedImages(code, !projector)
  const ownedIds = useMemo(() => new Set(owned.map((o) => o.id)), [owned])

  // Projector mode: 6-second auto-advance (PRD §F2).
  useEffect(() => {
    if (!projector || items.length === 0) return
    const t = setInterval(() => setSlide((s) => (s + 1) % items.length), 6000)
    return () => clearInterval(t)
  }, [projector, items.length])

  const close = useCallback(() => setOpen(null), [])

  if (projector) {
    return (
      <div data-theme="dark" className="min-h-screen bg-gray-950 p-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {items.map((item, i) => (
            <div
              key={item.id}
              className={clsx(
                'overflow-hidden rounded-2xl bg-gray-900 transition-all duration-700',
                i === slide ? 'ring-4 ring-brand-400 scale-[1.02]' : 'opacity-70',
              )}
            >
              <Image
                src={item.url}
                alt=""
                width={512}
                height={768}
                quality={80}
                className="h-full w-full object-cover"
                unoptimized={false}
              />
            </div>
          ))}
        </div>
        {items.length === 0 && loaded && (
          <p className="pt-40 text-center text-2xl text-gray-600">
            아직 그림이 없어요
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="min-h-screen pb-10">
      <header className="pt-safe sticky top-0 z-10 bg-gray-50/95 px-5 py-4 backdrop-blur">
        <h1 className="text-xl font-semibold text-gray-900">우리 반 그림</h1>
        <p className="text-sm text-gray-400">{items.length}장</p>
      </header>

      <MyPictures owned={owned} busyId={busyId} notice={notice} onSetInGallery={setInGallery} />

      {!loaded ? (
        <div className="grid grid-cols-2 gap-3 px-4">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="aspect-[2/3] animate-pulse rounded-2xl bg-gray-200" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="px-8 pt-24 text-center leading-relaxed text-gray-400">
          아직 그림이 없어요.
          <br />
          곧 친구들 그림이 올라올 거예요.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 px-4">
          {items.map((item, i) => {
            // Identification only — the action lives in the strip above. A 164px
            // card between 24 classmates' pictures is the wrong place for it, and
            // a button under the card would make one row taller than the others.
            const mine = ownedById.get(item.id)
            // The ≤5s window between "내리기" and the poll dropping the card.
            const pulled = mine?.inGallery === false
            return (
              <button
                key={item.id}
                onClick={() => setOpen(i)}
                className={clsx(
                  'relative overflow-hidden rounded-2xl bg-gray-200 active:opacity-80',
                  // Dual-coded per PRD §7: ring (colour) AND badge (text).
                  mine && 'ring-2 ring-brand-500',
                  pulled && 'opacity-40',
                )}
                aria-label={mine ? '내 그림 크게 보기' : '크게 보기'}
              >
                {/* Thumbnails ONLY in the grid. 25 viewers x 40 full-size images is
                    ~1.4GB of egress per class; at 512px it is ~60MB. */}
                <Image
                  src={item.url}
                  alt=""
                  width={512}
                  height={768}
                  quality={75}
                  sizes="(max-width: 640px) 50vw, 256px"
                  loading="lazy"
                  className="aspect-[2/3] h-full w-full object-cover"
                />
                {mine && (
                  <span
                    className={clsx(
                      'absolute top-2 left-2 rounded-full px-2 py-0.5 text-[11px] font-semibold text-white',
                      pulled ? 'bg-gray-900' : 'bg-brand-500',
                    )}
                  >
                    {pulled ? '내렸어요' : '내 그림'}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {open !== null && (
        <Lightbox items={items} startIndex={open} onClose={close} ownedIds={ownedIds} />
      )}
    </div>
  )
}
