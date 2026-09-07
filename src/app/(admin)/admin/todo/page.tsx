import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AdminPage } from '@/components/admin/AdminPage'
import { loadTodo } from '@/lib/todo'
import { TodoClient } from './TodoClient'

export const dynamic = 'force-dynamic'

export default async function TodoPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/admin/login')
  const todo = await loadTodo()
  const subtitle = todo.total === 0
    ? 'Nothing needs you right now.'
    : `${todo.total} thing${todo.total === 1 ? '' : 's'} need you, oldest first. Open one to see what is needed and reply or confirm right here.`
  return (
    <AdminPage title="To Do" subtitle={subtitle}>
      <TodoClient initial={todo} />
    </AdminPage>
  )
}
