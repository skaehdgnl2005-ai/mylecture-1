import { redirect } from 'next/navigation'
import { isTeacher } from '@/lib/auth'
import { QueuePanel } from '@/components/QueuePanel'

export const dynamic = 'force-dynamic'

export default async function QueuePage() {
  if (!(await isTeacher())) redirect('/teacher')
  return <QueuePanel />
}
