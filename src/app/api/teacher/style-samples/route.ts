import { NextResponse } from 'next/server'
import { db, logEvent } from '@/lib/db'
import { requireTeacher } from '@/lib/auth'
import { generateImage } from '@/lib/openai/image'
import { buildImagePrompt, STYLE, type StyleId } from '@/lib/prompt/build-image-prompt'
import { imageKey, uploadImage, deleteImages } from '@/lib/storage'
import { spacingMs } from '@/lib/env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET() {
  const denied = await requireTeacher()
  if (denied) return denied
  const { data } = await db().from('style_samples').select('style, url, created_at')
  return NextResponse.json({ samples: data ?? [] })
}

/**
 * Generate the three fixed style thumbnails (PRD §F4).
 *
 * RUN THIS THE DAY BEFORE THE LESSON. These are three REAL images out of a
 * 5-images-per-minute budget: doing it live costs the class ~40 seconds and
 * confuses the queue's position numbers.
 *
 * Goes through the same rate spacing as student jobs so it cannot itself cause
 * the 429 it is trying to avoid.
 */
const SAMPLE_SCENE = {
  actionEn: 'walking along a quiet street holding a warm drink, looking up',
  place: 'city',
  companions: ['alone'],
  mood: 'peaceful',
  time: 'sunset',
  gender: 'unspecified',
  attempt: 1,
} as const

export async function POST() {
  const denied = await requireTeacher()
  if (denied) return denied

  const styles = Object.keys(STYLE) as StyleId[]
  const results: Array<{ style: string; ok: boolean; error?: string }> = []

  for (let i = 0; i < styles.length; i++) {
    const style = styles[i]
    if (i > 0) await new Promise((r) => setTimeout(r, spacingMs()))

    try {
      const prompt = buildImagePrompt({ ...SAMPLE_SCENE, style, companions: ['alone'] })
      // Low quality on purpose: these are 64px-wide thumbnails on a phone.
      const image = await generateImage(prompt, { quality: 'low' })
      const key = imageKey('_samples', image.extension)
      const { url, path } = await uploadImage(key, image.bytes, image.contentType)

      // Replace rather than upsert-in-place: overwriting a storage path serves
      // stale CDN content, and the old object must be cleaned up explicitly.
      const { data: prev } = await db()
        .from('style_samples').select('storage_path').eq('style', style).maybeSingle()

      await db().from('style_samples').upsert({ style, url, storage_path: path })
      if (prev?.storage_path) await deleteImages([prev.storage_path]).catch(() => {})

      results.push({ style, ok: true })
    } catch (e) {
      results.push({ style, ok: false, error: (e as Error).message })
    }
  }

  await logEvent('style_samples_generated', { detail: { results } })
  return NextResponse.json({ ok: results.every((r) => r.ok), results })
}
