import { NextResponse } from 'next/server'
import { Readable } from 'node:stream'
import archiver from 'archiver'
import { db } from '@/lib/db'
import { requireTeacher } from '@/lib/auth'
import { downloadImage } from '@/lib/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Streaming ZIP export (PRD §F4).
 *
 * Three things that are easy to get wrong here:
 *
 *  1. Do NOT await the append loop before returning the Response. Awaiting
 *     buffers all ~50MB in memory and only then starts sending.
 *  2. Append sequentially, waiting on archiver's 'entry' event, or every image
 *     is pulled into memory at once. Peak memory is then one image, not forty.
 *  3. zlib level 0 (store). JPEG is already compressed; deflating it burns CPU
 *     for roughly nothing.
 *
 * archiver is pinned to ^7 deliberately: v8 switched to ESM named class exports
 * (`new ZipArchive(...)`) with no `archiver('zip', opts)` factory, so every
 * pre-2026 snippet fails silently against it.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const denied = await requireTeacher()
  if (denied) return denied
  const { code } = await ctx.params

  const { data: images } = await db()
    .from('images')
    .select('id, storage_path, tags, created_at')
    .eq('session_code', code)
    .order('created_at', { ascending: true })

  if (!images || images.length === 0) {
    return NextResponse.json({ error: '내려받을 그림이 없어요.' }, { status: 404 })
  }

  const archive = archiver('zip', { zlib: { level: 0 } })
  archive.on('error', (e: Error) => console.error('[zip]', e))

  // Deliberately not awaited — the loop runs while the response streams.
  void (async () => {
    let n = 1
    for (const img of images) {
      try {
        const blob = await downloadImage(img.storage_path)
        const buf = Buffer.from(await blob.arrayBuffer())
        const entered = new Promise<void>((resolve) => archive.once('entry', () => resolve()))
        archive.append(buf, { name: `${String(n).padStart(2, '0')}_${img.tags.join('-')}.jpg` })
        await entered // back-pressure: one image in memory at a time
      } catch (e) {
        console.error('[zip] skipped', img.id, e)
      }
      n++
    }
    await archive.finalize()
  })()

  return new NextResponse(Readable.toWeb(archive) as ReadableStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${code}.zip"`,
      'Cache-Control': 'no-store',
    },
  })
}
