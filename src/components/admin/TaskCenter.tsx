'use client'

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, AlertTriangle, MessageCircle, Mail, CreditCard, X, Loader2, ListChecks } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Task {
  id: string
  title: string
  description: string
  category: 'applications' | 'whatsapp' | 'support' | 'finance'
  priority: 'high' | 'medium' | 'low'
  actionUrl?: string
}

const CATEGORY_ICONS = {
  applications: AlertTriangle,
  whatsapp: MessageCircle,
  support: Mail,
  finance: CreditCard,
}

export function TaskCenter() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState(false)

  const dismissTask = useCallback(async (id: string) => {
    setDismissed((prev) => new Set([...prev, id]))
    try {
      await fetch('/api/admin/task-dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: id }),
      })
    } catch { /* best effort */ }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [appsRes, supportRes, statsRes] = await Promise.all([
          fetch('/api/admin/applications?status=pending&limit=1'),
          fetch('/api/admin/support-inbox/threads?status=open'),
          fetch('/api/admin/stats'),
        ])

        const incoming: Task[] = []

        // Pending applications
        if (appsRes.ok) {
          const apps = await appsRes.json()
          const count = apps.total || apps.count || apps.applications?.length || 0
          if (count > 0) {
            incoming.push({
              id: 'pending-apps',
              title: `${count} pending application${count !== 1 ? 's' : ''}`,
              description: 'New vendor applications waiting for review and approval.',
              category: 'applications',
              priority: count > 100 ? 'high' : 'medium',
              actionUrl: '/admin/applications',
            })
          }
        }

        // Unread support inbox
        if (supportRes.ok) {
          const support = await supportRes.json()
          const unread = (support.threads || []).reduce((s: number, t: { unread_count?: number }) => s + (t.unread_count || 0), 0)
          if (unread > 0) {
            incoming.push({
              id: 'support-unread',
              title: `${unread} unread support message${unread !== 1 ? 's' : ''}`,
              description: 'Inbound festival email needs attention.',
              category: 'support',
              priority: unread > 10 ? 'high' : 'medium',
              actionUrl: '/admin/support-inbox',
            })
          }
        }

        // Stale pending (older than 30 days)
        if (statsRes.ok) {
          const stats = await statsRes.json()
          const staleApps = stats.stalePending ?? stats.oldPending ?? 0
          if (staleApps > 50) {
            incoming.push({
              id: 'stale-apps',
              title: `${staleApps} applications pending >30 days`,
              description: 'Vendors have been waiting over a month. Review the queue.',
              category: 'applications',
              priority: 'low',
              actionUrl: '/admin/applications',
            })
          }
        }

        if (!cancelled) setTasks(incoming)
      } catch {
        if (!cancelled) setTasks([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const interval = setInterval(load, 60000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  const visible = tasks.filter((t) => !dismissed.has(t.id))

  if (loading) return null

  return (
    <div className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-neutral-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <ListChecks className="w-4 h-4 text-[#cd2653]" />
          <span className="text-sm font-semibold text-neutral-900">Tasks</span>
          {visible.length > 0 && (
            <span className="text-[10px] font-bold bg-[#cd2653] text-white rounded-full px-1.5 py-0.5">
              {visible.length}
            </span>
          )}
        </div>
        <span className="text-[11px] text-neutral-400">{collapsed ? 'Show' : 'Hide'}</span>
      </button>

      {!collapsed && (
        <div className="divide-y divide-neutral-100">
          {visible.length === 0 && !loading && (
            <p className="px-4 py-6 text-sm text-neutral-400 text-center">All clear. No pending tasks.</p>
          )}
          {visible.map((task) => {
            const Icon = CATEGORY_ICONS[task.category]
            return (
              <div key={task.id} className="px-4 py-3 flex items-start gap-3 group">
                <div className={cn(
                  'mt-0.5 w-7 h-7 rounded-full flex items-center justify-center shrink-0',
                  task.priority === 'high' ? 'bg-rose-50 text-rose-600' :
                  task.priority === 'medium' ? 'bg-amber-50 text-amber-600' :
                  'bg-neutral-100 text-neutral-500'
                )}>
                  <Icon className="w-3.5 h-3.5" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-neutral-900">{task.title}</p>
                  <p className="text-xs text-neutral-500 mt-0.5">{task.description}</p>
                  {task.actionUrl && (
                    <a
                      href={task.actionUrl}
                      className="text-[11px] font-medium text-[#cd2653] hover:underline mt-1 inline-block"
                    >
                      View →
                    </a>
                  )}
                </div>
                <button
                  onClick={() => dismissTask(task.id)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100"
                  title="Dismiss"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
