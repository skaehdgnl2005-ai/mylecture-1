import { isTeacher } from '@/lib/auth'
import { TeacherLogin } from '@/components/TeacherLogin'
import { TeacherConsole } from '@/components/TeacherConsole'

export const dynamic = 'force-dynamic'

export default async function TeacherPage() {
  return (await isTeacher()) ? <TeacherConsole /> : <TeacherLogin />
}
