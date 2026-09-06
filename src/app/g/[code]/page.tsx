import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { db } from '@/lib/db'
import { Gallery } from '@/components/Gallery'

export const dynamic = 'force-dynamic'

// Inherited from the root layout, restated here so the gallery cannot be
// indexed even if the root metadata is ever loosened (PRD §6-4).
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
}

export default async function GalleryPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>
  searchParams: Promise<{ projector?: string }>
}) {
  const [{ code: raw }, sp] = await Promise.all([params, searchParams])
  const code = raw.toUpperCase()

  // Without the session code there is no gallery (PRD §F2).
  const { data: session } = await db()
    .from('sessions')
    .select('code')
    .eq('code', code)
    .maybeSingle()
  if (!session) notFound()

  return <Gallery code={code} projector={sp.projector === '1'} />
}
