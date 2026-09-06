import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { downloadImage } from '@/lib/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Same-origin download proxy.
 *
 * iOS Safari SILENTLY IGNORES the `download` attribute on a cross-origin URL —
 * it just navigates to the image. Only same-origin, blob: and data: work. So
 * the student's save button points here rather than at the Supabase URL.
 *
 * Note also that when the server sends Content-Disposition with a filename,
 * that filename wins over the anchor's download attribute — which is why the
 * name is set here rather than in the markup.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params

  const { data: image } = await db()
    .from('images')
    .select('storage_path, is_hidden')
    .eq('id', id)
    .maybeSingle()

  if (!image || image.is_hidden) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const blob = await downloadImage(image.storage_path)
  return new NextResponse(blob.stream(), {
    headers: {
      'Content-Type': 'image/jpeg',
      // Non-ASCII in a raw header value is invalid; RFC 5987 form is required,
      // with an ASCII fallback for anything that does not understand filename*.
      'Content-Disposition':
        `attachment; filename="my-future.jpg"; ` +
        `filename*=UTF-8''${encodeURIComponent('10년뒤의나.jpg')}`,
      'Cache-Control': 'private, max-age=3600',
    },
  })
}
