import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AdminPage } from '@/components/admin/AdminPage'
import { loadTodo } from '@/lib/todo'

export const dynamic = 'force-dynamic'

function ago(iso: string | null): string {
  if (!iso) return ''
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 36e5)
  if (h < 1) return 'just now'
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}

export default async function TodoPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/admin/login')
  const todo = await loadTodo()

  return (
    <AdminPage title="To Do" subtitle={todo.total === 0 ? 'Nothing needs you right now.' : `${todo.total} thing${todo.total === 1 ? '' : 's'} need you. Oldest first. Items disappear once handled.`}>
      <div className="space-y-6">
        {todo.sections.filter((s) => s.items.length > 0).map((s) => (
          <section key={s.key} className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
            <header className="flex items-center justify-between px-5 py-3 border-b border-neutral-100">
              <h2 className="text-sm font-semibold text-neutral-800">{s.label}</h2>
              <span className="text-xs font-medium text-neutral-500">{s.items.length}</span>
            </header>
            <ul className="divide-y divide-neutral-100">
              {s.items.map((it, i) => (
                <li key={`${s.key}-${i}`}>
                  <Link href={it.href} className="flex items-start gap-4 px-5 py-3 hover:bg-neutral-50">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-neutral-900 truncate">{it.title}</div>
                      {it.detail && <div className="text-sm text-neutral-500 truncate">{it.detail}</div>}
                    </div>
                    <div className="shrink-0 text-xs text-neutral-400 tabular-nums pt-0.5">{ago(it.since)}</div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {todo.total === 0 && (
          <div className="rounded-xl border border-neutral-200 bg-white px-5 py-10 text-center text-sm text-neutral-500">All caught up.</div>
        )}
      </div>
    </AdminPage>
  )
}
