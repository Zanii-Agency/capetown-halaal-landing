import { CheckCircle2, Circle, CircleDot, ArrowRight, PartyPopper } from 'lucide-react'
import { getExhibitorContext } from '@/lib/exhibitor'
import { parsePortalState } from '@/lib/portal-state'
import { getRequiredDocs } from '@/lib/exhibitor/required-docs'
import { Card } from '@/components/chrome/PageChrome'

// Per-row state. 'optional' means the task isn't enforced for this vendor and
// the row renders as info, not a blocker. We use it for the staff-badges task
// because no badges_submitted_at column or marker exists on this Supabase
// instance (anti-hallucination rule 3, no phantom columns).
export type TaskStatus = 'done' | 'in-progress' | 'todo' | 'optional'

export interface TaskRow {
  key: 'contract' | 'payment' | 'documents' | 'staff'
  label: string
  subtitle: string
  href: string
  status: TaskStatus
}

/**
 * Single source of truth for the 4 vendor self-service tasks. Resolves the
 * vendor's row via the same session helper portal pages already use
 * (getExhibitorContext at src/lib/exhibitor.ts:18) and reads payment + docs
 * state through parsePortalState (src/lib/portal-state.ts:83). Returns the
 * ordered task list so TaskChecklist and MiniTaskStrip share identical data.
 */
export async function loadTasks(): Promise<{ tasks: TaskRow[]; firstName: string } | null> {
  const ctx = await getExhibitorContext()
  if (!ctx) return null
  const app = (ctx.application || {}) as Record<string, unknown>
  const notes = (app.admin_notes as string) || ''
  const state = parsePortalState(notes)

  // Contract: real column contract_signed_at (src/app/exhibitor/portal/contract/page.tsx:18).
  const contractDone = Boolean(app.contract_signed_at)

  // Payment: portal-state marker only, no payment_status column read here.
  const paymentStatus = state.payment?.status || 'none'
  const paymentDone = paymentStatus === 'paid' || paymentStatus === 'waived'
  const paymentPartial = paymentStatus === 'pending' || paymentStatus === 'deferred'

  // Docs: required list comes from getRequiredDocs (src/lib/exhibitor/required-docs.ts:51),
  // uploaded list is state.docs[] (src/lib/portal-state.ts:61).
  const productCategories = Array.isArray(app.product_categories)
    ? (app.product_categories as string[])
    : []
  const requiredDocs = getRequiredDocs({
    productCategories,
    boothTier: (app.preferred_booth_tier as string) || null,
  })
  const docTypes = new Set((state.docs || []).map((d) => d.type))
  const docsUploaded = requiredDocs.filter((t) => docTypes.has(t)).length
  let docsStatus: TaskStatus
  if (requiredDocs.length === 0) docsStatus = 'optional'
  else if (docsUploaded === requiredDocs.length) docsStatus = 'done'
  else if (docsUploaded > 0) docsStatus = 'in-progress'
  else docsStatus = 'todo'

  // Staff: no badges_submitted_at column, no staff_count column, no marker
  // shape for "badges submitted". state.staff[] is the gate-access car list,
  // not a badge submission flag. Per anti-hallucination rule 3, this row is
  // 'optional' until a real signal lands. We still show progress if any
  // entries exist, so vendors see momentum.
  const staffEntries = (state.staff || []).length
  const staffStatus: TaskStatus = staffEntries > 0 ? 'in-progress' : 'optional'

  const contactName = (app.contact_name as string) || ''
  const firstName = (contactName.trim().split(/\s+/)[0]) || 'there'

  const tasks: TaskRow[] = [
    {
      key: 'contract',
      label: 'Sign your vendor contract',
      subtitle: contractDone ? 'Signed and on file.' : 'Required before payment unlocks the rest of the portal.',
      href: '/exhibitor/portal/contract',
      status: contractDone ? 'done' : 'todo',
    },
    {
      key: 'payment',
      label: 'Pay your stall fee',
      subtitle: paymentDone
        ? 'Received, thank you.'
        : paymentPartial
        ? 'Awaiting clearance, we will confirm once the bank posts it.'
        : 'Pay securely by card via Yoco.',
      href: '/exhibitor/portal/payments',
      status: paymentDone ? 'done' : paymentPartial ? 'in-progress' : 'todo',
    },
    {
      key: 'documents',
      label: 'Upload compliance documents',
      subtitle:
        requiredDocs.length === 0
          ? 'No festival-level documents required for your category.'
          : docsStatus === 'done'
          ? `All ${requiredDocs.length} uploaded.`
          : `${docsUploaded} of ${requiredDocs.length} uploaded.`,
      href: '/exhibitor/portal/documents',
      status: docsStatus,
    },
    {
      key: 'staff',
      label: 'Register your gate access list',
      subtitle:
        staffEntries > 0
          ? `${staffEntries} on your manifest, add up to 3 vehicles.`
          : 'Register drivers and vehicle registrations for gate access. Optional, do it closer to show week.',
      href: '/exhibitor/portal/staff',
      status: staffStatus,
    },
  ]

  return { tasks, firstName }
}

function StatusIcon({ status }: { status: TaskStatus }) {
  if (status === 'done')
    return <CheckCircle2 className="w-6 h-6 text-emerald-600 shrink-0" aria-label="Done" />
  if (status === 'in-progress')
    return <CircleDot className="w-6 h-6 text-amber-500 shrink-0" aria-label="In progress" />
  // todo and optional both render as a gray circle, but optional rows are
  // styled lighter on the label.
  return <Circle className="w-6 h-6 text-[#1B1A17]/25 shrink-0" aria-label={status === 'optional' ? 'Optional' : 'To do'} />
}

function StatusPill({ status }: { status: TaskStatus }) {
  const map: Record<TaskStatus, { tone: string; label: string }> = {
    done: { tone: 'bg-emerald-50 text-emerald-700 border-emerald-200', label: 'Done' },
    'in-progress': { tone: 'bg-amber-50 text-amber-700 border-amber-200', label: 'In progress' },
    todo: { tone: 'bg-[#cd2653]/10 text-[#bf3026] border-[#cd2653]/30', label: 'To do' },
    optional: { tone: 'bg-[#FFFFFF] text-[#1B1A17]/55 border-[#E5E5E5]', label: 'Optional' },
  }
  const s = map[status]
  return (
    <span className={`text-[10px] font-bold tracking-[0.14em] uppercase px-2.5 py-1 rounded-full border ${s.tone}`}>
      {s.label}
    </span>
  )
}

// Renders the 4-row checklist. When every required task is done (optional
// rows don't block), shows a celebration card instead.
export default async function TaskChecklist() {
  const loaded = await loadTasks()
  if (!loaded) return null
  const { tasks } = loaded

  // "Set" means: every non-optional task is done.
  const required = tasks.filter((t) => t.status !== 'optional')
  const allRequiredDone = required.length > 0 && required.every((t) => t.status === 'done')

  if (allRequiredDone) {
    return (
      <Card className="border-emerald-200 bg-emerald-50/40">
        <div className="flex items-start gap-4">
          <PartyPopper className="w-7 h-7 text-emerald-600 mt-0.5 shrink-0" />
          <div>
            <p className="font-serif text-xl text-[#1B1A17]">You are set for 11 to 13 December.</p>
            <p className="text-sm text-[#1B1A17]/70 mt-1">
              We will be in touch with load-in details closer to the date. Watch the Inbox tab for organiser messages.
            </p>
          </div>
        </div>
      </Card>
    )
  }

  const doneCount = required.filter((t) => t.status === 'done').length

  return (
    <Card>
      <div className="flex items-end justify-between mb-4">
        <div>
          <p className="font-semibold text-[#1B1A17]">Your 4 tasks</p>
          <p className="text-xs text-[#1B1A17]/55 mt-0.5">
            {doneCount} of {required.length} required steps done. Click any row to jump in.
          </p>
        </div>
      </div>
      <ul className="divide-y divide-[#E5E5E5]/40">
        {tasks.map((t) => (
          <li key={t.key}>
            <a
              href={t.href}
              className="group flex items-center gap-4 py-3.5 -mx-2 px-2 rounded-lg hover:bg-[#FDFAF1] transition-colors"
            >
              <StatusIcon status={t.status} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p
                    className={`text-sm font-semibold ${
                      t.status === 'done'
                        ? 'text-[#1B1A17]/45 line-through'
                        : t.status === 'optional'
                        ? 'text-[#1B1A17]/70'
                        : 'text-[#1B1A17]'
                    }`}
                  >
                    {t.label}
                  </p>
                  <StatusPill status={t.status} />
                </div>
                <p className="text-xs text-[#1B1A17]/55 mt-0.5">{t.subtitle}</p>
              </div>
              {t.status !== 'done' && (
                <span className="hidden sm:inline-flex items-center gap-1.5 text-xs font-semibold text-[#cd2653] group-hover:text-[#bf3026] shrink-0">
                  Do it now
                  <ArrowRight className="w-4 h-4" />
                </span>
              )}
            </a>
          </li>
        ))}
      </ul>
    </Card>
  )
}
