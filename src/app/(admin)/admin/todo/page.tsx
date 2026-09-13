import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AdminPage } from '@/components/admin/AdminPage'
import { loadTodo } from '@/lib/todo'
import { TodoClient } from './TodoClient'
import { DayCard } from './DayCard'
import { loadDayDigest } from '@/lib/day-digest'

export const dynamic = 'force-dynamic'

export default async function TodoPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/admin/login')
  const [todo, day] = await Promise.all([loadTodo(), loadDayDigest()])
  const subtitle = todo.total === 0
    ? 'Nothing needs you right now.'
    : `${todo.total} thing${todo.total === 1 ? '' : 's'} need you, oldest first. Open one to see what is needed and reply or confirm right here.`
  return (
    <AdminPage title="To Do" subtitle={subtitle}>
      <div className="space-y-6">
        <DayCard initial={day} />
        <TodoClient initial={todo} />
      </div>
    </AdminPage>
  )
}
