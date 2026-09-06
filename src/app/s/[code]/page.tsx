import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { StudentApp } from '@/components/StudentApp'

export const dynamic = 'force-dynamic'

/**
 * Thin Server Component: awaits params (Next 16 — synchronous access is a hard
 * error now), loads the pinned style samples, hands plain data to the client.
 */
export default async function StudentPage({
  params,
}: {
  params: Promise<{ code: string }>
}) {
  const { code: raw } = await params
  const code = raw.toUpperCase()

  const { data: session } = await db()
    .from('sessions')
    .select('code')
    .eq('code', code)
    .maybeSingle()
  if (!session) notFound()

  const { data: samples } = await db().from('style_samples').select('style, url')

  const styleSamples: Record<string, string | null> = {
    anime: null, photo: null, watercolor: null,
  }
  for (const s of samples ?? []) styleSamples[s.style] = s.url

  return <StudentApp code={code} styleSamples={styleSamples} />
}
