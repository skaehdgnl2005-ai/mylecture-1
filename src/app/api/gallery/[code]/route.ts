import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { env } from '@/lib/env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * PRD §F2 / §6-4 anonymity is enforced HERE, in one SELECT, in TypeScript a
 * reviewer can read — rather than by column grants spread across RLS policies.
 * That is the main architectural reason this app polls instead of using
 * Supabase Realtime: `postgres_changes` authorises per subscriber, which would
 * require opening public.images to the anon role and hand-maintaining column
 * grants so created_at and the free sentence do not leak through PostgREST.
 *
 * The select list is EXACTLY id, url, tags. Not created_at (PRD: no timestamps),
 * not device_id, not job_id, and there is no path from here to raw_text_ko.
 *
 * ── Egress arithmetic, kept here on purpose ──────────────────────────────────
 * 25 viewers x 40 images x ~1.4MB full-size  = ~1.4 GB per class
 *   -> 28% of Supabase Free's 5GB egress in ONE lesson.
 * The grid therefore renders 512px thumbnails via next/image (~60KB each)
 *   -> ~60 MB per class, roughly a 20x reduction.
 * If you are about to render `url` directly in the grid: don't. Read this first.
 */
export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code: raw } = await ctx.params
  const code = raw.toUpperCase()

  const { data: session } = await db()
    .from('sessions')
    .select('code')
    .eq('code', code)
    .maybeSingle()
  // Without the session code there is no gallery. No enumeration, no listing.
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const { data, error } = await db()
    .from('images')
    .select('id, url, tags')
    .eq('session_code', code)
    .eq('is_hidden', false)
    .eq('in_gallery', true)
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) return NextResponse.json({ error: 'query failed' }, { status: 500 })

  const items = data ?? []

  // Cheap change-detection so a room full of phones polling every 5s mostly
  // gets 304s.
  //
  // Count plus newest id is NOT enough on its own: two different sets of the
  // same size with the same newest member collide. That used to be unreachable
  // (the count only ever fell without a teacher un-hiding), but students can now
  // put their own picture back from the gallery screen, so one student removing
  // while another restores inside the same 5-second window is an ordinary
  // classroom event — and it would have served a stale grid to every phone.
  // The id digest closes that hole. It is one pass over at most 500 short
  // strings, and it stays IDENTICAL for every viewer, which is the property that
  // makes the 304s worth having.
  let digest = 0x811c9dc5
  for (const item of items) {
    for (let i = 0; i < item.id.length; i++) {
      digest = ((digest ^ item.id.charCodeAt(i)) * 0x01000193) >>> 0
    }
  }
  const etag = `W/"${items.length}-${items[0]?.id ?? 'empty'}-${digest.toString(36)}"`
  if (req.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag } })
  }

  return NextResponse.json(
    { items, pollIntervalMs: env().GALLERY_POLL_MS },
    { headers: { ETag: etag, 'Cache-Control': 'no-store' } },
  )
}
