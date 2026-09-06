import { NextResponse } from 'next/server'
import { renderSVG } from 'uqr'
import { requireTeacher } from '@/lib/auth'
import { env } from '@/lib/env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Server-rendered QR (PRD §4-1). uqr is zero-dependency and renders to an SVG
 * string, so nothing ships to the client — the code never changes while it is
 * on screen, so there is no reason to render it in the browser.
 */
export async function GET(req: Request) {
  const denied = await requireTeacher()
  if (denied) return denied

  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  if (!code || !/^[A-Z0-9]{4}$/.test(code)) {
    return NextResponse.json({ error: 'bad code' }, { status: 400 })
  }

  const base = env().APP_URL ?? url.origin
  const svg = renderSVG(`${base}/s/${code}`, { ecc: 'M', border: 2 })

  return new NextResponse(svg, {
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' },
  })
}
