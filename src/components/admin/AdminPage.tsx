'use client'

import { AdminPageHeader } from './AdminPageHeader'

interface AdminPageProps {
  caption?: string
  title: string
  subtitle?: string
  actions?: React.ReactNode
  children: React.ReactNode
  /**
   * Fill the full height of the (desktop) main scroll area instead of growing
   * with content. The outer container becomes a full-height flex column and the
   * children get the remaining space (flex-1). Used by the Inbox so the chat
   * pane reaches the bottom of the page. Mobile falls back to normal flow, so
   * the child should still carry its own base height there.
   */
  fill?: boolean
}

export function AdminPage({ caption, title, subtitle, actions, children, fill }: AdminPageProps) {
  if (fill) {
    return (
      <div className="p-6 lg:p-8 flex flex-col gap-6 lg:h-full min-h-0">
        <AdminPageHeader caption={caption} title={title} subtitle={subtitle} actions={actions} />
        <div className="flex-1 min-h-0">{children}</div>
      </div>
    )
  }
  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader caption={caption} title={title} subtitle={subtitle} actions={actions} />
      {children}
    </div>
  )
}
