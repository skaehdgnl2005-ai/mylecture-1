'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { clsx } from 'clsx'

export interface GalleryItem {
  id: string
  url: string
  tags: string[]
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
 * Fullscreen viewer: CSS scroll-snap plus IntersectionObserver for the index.
 * Zero dependencies, native momentum. `scrollend` only reached Baseline in
 * December 2025, so the observer is what tracks position.
 */
function Lightbox({
  items,
  startIndex,
  onClose,
}: {
  items: GalleryItem[]
  startIndex: number
  onClose: () => void
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
        <span className="text-sm tabular-nums">
          {index + 1} / {items.length}
        </span>
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
          {items.map((item, i) => (
            <button
              key={item.id}
              onClick={() => setOpen(i)}
              className="overflow-hidden rounded-2xl bg-gray-200 active:opacity-80"
              aria-label="크게 보기"
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
            </button>
          ))}
        </div>
      )}

      {open !== null && <Lightbox items={items} startIndex={open} onClose={close} />}
    </div>
  )
}
