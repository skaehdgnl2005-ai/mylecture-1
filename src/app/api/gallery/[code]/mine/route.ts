import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * "Which pictures in this session belong to this device?" (PRD §F2 — 학생은 본인
 * 그림만 갤러리에서 내릴 수 있음).
 *
 * WHY THIS IS A SEPARATE ROUTE, not a flag on /api/gallery/[code]:
 * that route's select list stays EXACTLY (id, url, tags) — the single documented
 * place §F2/§6-4 anonymity is enforced. Adding an ownership flag would also make
 * the response per-device, which destroys its shared ETag (count + newest id).
 * That ETag is what turns 25 phones polling every 5 seconds into 304s for a whole
 * lesson; a per-device body would make every one of those a full 200 carrying
 * ~40 image URLs. So ownership gets its own, low-frequency channel.
 *
 * WHY POST WITH A BODY rather than GET with ?deviceId=:
 * the device id here is proof of who you are, exactly as it is for the DELETE
 * below — not a narrowing filter on a resource you already named (which is what
 * /api/jobs/[id]?deviceId= is). Vercel and Supabase log method, path and query
 * string, never bodies, and this is hit on every gallery mount by every phone in
 * the room. A POST response is also uncacheable by construction, so there is no
 * path by which device A's answer reaches device B's screen.
 *
 * WHAT THIS LEAKS: nothing beyond what DELETE /api/gallery/image/[id] already
 * permits. That route already answers "is image X owned by device D?" — 200 for
 * yes, 404 for no — so a caller holding D's UUID can establish ownership one
 * image at a time, at the cost of actually taking the picture down. This answers
 * the same question in bulk and without the side effect. The mapping is one-way:
 * you can ask "what belongs to this device", never "which device owns this
 * picture". /api/gallery/[code] still returns no device_id, so the browser has no
 * join available and §F2 anonymity is unchanged.
 */
const Body = z.object({ deviceId: z.string().uuid() })

export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
  // Next 16: params is a Promise and synchronous access is a hard error.
  const { code: raw } = await ctx.params
  const code = raw.toUpperCase()

  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'deviceId required' }, { status: 400 })

  const { data: session } = await db()
    .from('sessions')
    .select('code')
    .eq('code', code)
    .maybeSingle()
  // Same no-enumeration posture as the gallery route itself.
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const { data, error } = await db()
    .from('images')
    // is_hidden = false is deliberate. A teacher-hidden picture simply
    // disappears from the student's strip, exactly as it disappears from the
    // gallery. The student is never told a teacher hid their picture — that is a
    // classroom-management landmine — and a 다시 올리기 button on a hidden row
    // would be a lie anyway, because in_gallery = true would not bring it back.
    .select('id, url, in_gallery')
    .eq('session_code', code)
    .eq('device_id', parsed.data.deviceId)
    .eq('is_hidden', false)
    // Ordering by created_at is not exposing created_at: the select list is
    // id/url/in_gallery, and ORDER BY reads a column it does not return.
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) return NextResponse.json({ error: 'query failed' }, { status: 500 })

  // A well-formed but unknown device id gets 200 with an empty list, never a
  // 404: there must be no device-existence oracle.
  //
  // Returning `url` for a taken-down picture is not a new disclosure — it is the
  // student's own image, they already had the URL on the result screen, and the
  // guard is the same device id the DELETE accepts.
  return NextResponse.json(
    {
      items: (data ?? []).map((i) => ({ id: i.id, url: i.url, inGallery: i.in_gallery })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
