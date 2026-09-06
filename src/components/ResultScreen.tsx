'use client'

import { useEffect, useRef, useState } from 'react'
import { PrimaryButton, SecondaryButton } from './ui'

/**
 * Saving a picture to a phone is the least portable thing in this app.
 *
 *  - `<a download>` is SILENTLY IGNORED by iOS Safari for a cross-origin URL —
 *    it just navigates to the image. So the anchor points at our own
 *    /api/images/[id]/file proxy, never at the Supabase URL.
 *  - Even a successful download on iOS lands in Files, NOT the camera roll.
 *    `navigator.share({ files })` is the only route to Photos.
 *  - share() needs transient activation, which a slow fetch inside the click
 *    handler burns. So the blob is prefetched when this screen mounts.
 *  - share() rejects with AbortError when the user dismisses the sheet. That is
 *    a cancellation, not a failure, and must not show an error.
 */
function useShareableFile(imageId: string | null) {
  const fileRef = useRef<File | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!imageId) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/images/${imageId}/file`)
        if (!res.ok) return
        const blob = await res.blob()
        if (cancelled) return
        fileRef.current = new File([blob], 'my-future.jpg', { type: 'image/jpeg' })
        setReady(true)
      } catch {
        /* fall back to the download anchor */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [imageId])

  return { fileRef, ready }
}

export function ResultScreen({
  imageId,
  imageUrl,
  tags,
  remaining,
  inGallery,
  onToggleGallery,
  galleryBusy = false,
  galleryNotice = null,
  onRedraw,
  onOpenGallery,
}: {
  imageId: string
  imageUrl: string
  tags: string[]
  remaining: number
  inGallery: boolean
  onToggleGallery: (next: boolean) => void
  /** A flip is in flight — stops a double-tap firing two opposite requests. */
  galleryBusy?: boolean
  galleryNotice?: string | null
  onRedraw: () => void
  onOpenGallery: () => void
}) {
  const { fileRef, ready } = useShareableFile(imageId)
  const [hint, setHint] = useState<string | null>(null)

  const save = async () => {
    const file = fileRef.current
    const nav = navigator as Navigator & {
      canShare?: (d: { files: File[] }) => boolean
      share?: (d: { files: File[] }) => Promise<void>
    }

    if (file && nav.share && nav.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file] })
        return
      } catch (e) {
        // Dismissing the share sheet is a cancellation, not an error.
        if ((e as Error)?.name === 'AbortError') return
      }
    }

    // Same-origin anchor. Works on Android and desktop; on iOS this lands in
    // Files rather than Photos, which is what the hint below explains.
    const a = document.createElement('a')
    a.href = `/api/images/${imageId}/file`
    a.download = 'my-future.jpg'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setHint('저장이 안 되면 그림을 꾹 눌러 "사진에 추가"를 선택해 주세요.')
  }

  return (
    <div className="h-screen-safe flex flex-col">
      <div className="flex flex-1 flex-col overflow-y-auto px-4 pt-4">
        {/* PRD §7: the picture is at least 70% of the screen. */}
        <div className="relative mx-auto w-full max-w-md flex-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl}
            alt="내가 그린 10년 뒤의 하루"
            className="h-full w-full rounded-3xl bg-gray-100 object-contain"
          />
        </div>

        <div className="mx-auto mt-3 flex max-w-md flex-wrap justify-center gap-1.5">
          {tags.map((t) => (
            <span key={t} className="rounded-full bg-white px-3 py-1 text-[13px] text-gray-500">
              {t}
            </span>
          ))}
        </div>

        <label className="mx-auto mt-4 flex w-full max-w-md items-center justify-between rounded-2xl bg-white px-4 py-3.5">
          <span className="text-[15px] text-gray-700">친구들과 함께 보기</span>
          <input
            type="checkbox"
            checked={inGallery}
            disabled={galleryBusy}
            onChange={(e) => onToggleGallery(e.target.checked)}
            className="h-6 w-11 appearance-none rounded-full bg-gray-200 transition-colors checked:bg-brand-500 relative before:absolute before:top-0.5 before:left-0.5 before:h-5 before:w-5 before:rounded-full before:bg-white before:transition-transform checked:before:translate-x-5 disabled:opacity-50"
          />
        </label>

        {galleryNotice && (
          <p className="mx-auto mt-2 w-full max-w-md rounded-2xl bg-amber-50 px-4 py-2.5 text-[13px] leading-relaxed text-amber-900">
            {galleryNotice}
          </p>
        )}

        {hint && (
          <p className="mx-auto mt-3 max-w-md rounded-2xl bg-amber-50 px-4 py-3 text-[14px] leading-relaxed text-amber-900">
            {hint}
          </p>
        )}
      </div>

      <div className="pb-safe space-y-2.5 px-4 pt-3">
        <PrimaryButton onClick={save} disabled={!ready && !imageId}>
          그림 저장하기
        </PrimaryButton>
        {remaining > 0 ? (
          <SecondaryButton onClick={onRedraw}>다시 그리기 (남은 {remaining}회)</SecondaryButton>
        ) : (
          <SecondaryButton onClick={onOpenGallery}>친구들 그림 보기</SecondaryButton>
        )}
      </div>
    </div>
  )
}
