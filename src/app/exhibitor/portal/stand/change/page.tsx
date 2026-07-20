import Link from 'next/link'
import { ArrowLeft, Maximize2, Move } from 'lucide-react'
import { requireApproved } from '@/lib/exhibitor-paygate'
import { getExhibitorContext } from '@/lib/exhibitor'
import { parsePortalState } from '@/lib/portal-state'
import { parseAllocation, TIER_META, TYPE_META, type StallType } from '@/lib/stalls'
import { ChangeRequestForm } from './ChangeRequestForm'
import { StallMoveForm } from './StallMoveForm'

export const dynamic = 'force-dynamic'

function StatusBox({ tone, title, body }: { tone: 'pending' | 'approved' | 'rejected'; title: string; body: string }) {
  const styles = {
    pending: 'border-amber-200 bg-amber-50 text-amber-800',
    approved: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    rejected: 'border-neutral-200 bg-neutral-50 text-neutral-700',
  }[tone]
  return (
    <div className={`rounded-xl border p-5 ${styles}`}>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs opacity-80 mt-1">{body}</p>
    </div>
  )
}

export default async function StandChangePage() {
  // Approved vendors only — but NOT gated on contract/payment/allocation, so a
  // vendor can fix their stall size or position right after approval, before the
  // contract locks their fee and before they are placed on the map.
  await requireApproved()
  const ctx = await getExhibitorContext()
  const app = (ctx?.application as Record<string, unknown>) || {}
  const notes = (app.admin_notes as string) || ''
  const state = parsePortalState(notes)
  const allocation = parseAllocation(notes)
  const currentTier = (app.preferred_booth_tier as string) || ''
  const currentTierLabel = TIER_META[currentTier]?.label || currentTier || 'Not set'
  const stallCode = allocation.stall || null
  const sizeReq = state.stallChangeRequest || null
  const moveReq = state.stallMoveRequest || null

  const tiers = Object.entries(TIER_META).map(([slug, meta]) => ({
    slug, label: meta.label, price: meta.price,
  }))
  const zones = (Object.keys(TYPE_META) as StallType[]).map((key) => ({
    key, label: TYPE_META[key].label,
  }))

  return (
    <div className="bg-[#FAFAF8] -mx-4 sm:-mx-6 px-4 sm:px-6 py-6 min-h-[calc(100vh-72px)]">
      <div className="max-w-3xl mx-auto space-y-8">
        <Link
          href="/exhibitor/portal/stand"
          className="inline-flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-900 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back to My Stand
        </Link>

        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[#cd2653] font-semibold">Stall requests</p>
          <h1 className="font-serif text-3xl text-neutral-900 mt-1">Change your stall</h1>
          <p className="text-sm text-neutral-600 mt-2">
            Two separate requests. Use <span className="font-medium text-neutral-900">stall size</span> to change how big your
            booth is, and <span className="font-medium text-neutral-900">stall position</span> to ask to be placed in a different spot or area.
            Both are available from the moment you are approved.
          </p>
        </div>

        {/* FEATURE 1: stall SIZE (tier) */}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Maximize2 className="w-4 h-4 text-[#cd2653]" />
            <h2 className="text-lg font-serif text-neutral-900">Change your stall size</h2>
          </div>
          <p className="text-xs text-neutral-500">
            Switch to a bigger or smaller booth. Current size: <span className="font-medium text-neutral-700">{currentTierLabel}</span>.
            Do this before you pay so your fee matches the size you want.
          </p>
          {sizeReq && sizeReq.status === 'pending' ? (
            <StatusBox
              tone="pending"
              title={`Pending: ${TIER_META[sizeReq.currentTier]?.label || sizeReq.currentTier || 'current size'} → ${TIER_META[sizeReq.requestedTier]?.label || sizeReq.requestedTier}`}
              body="The organisers will review your size change. Check back here for updates."
            />
          ) : sizeReq && sizeReq.status === 'approved' ? (
            <StatusBox
              tone="approved"
              title={`Approved: ${TIER_META[sizeReq.requestedTier]?.label || sizeReq.requestedTier}`}
              body="Your stall size has been updated. See My Stand for details."
            />
          ) : (
            <>
              {sizeReq && sizeReq.status === 'rejected' && (
                <StatusBox tone="rejected" title="Your last size change was declined." body={sizeReq.adminNote || 'You can submit a new request below.'} />
              )}
              <ChangeRequestForm
                currentTier={currentTier}
                currentTierLabel={currentTierLabel}
                stallCode={stallCode}
                tiers={tiers}
              />
            </>
          )}
        </section>

        <hr className="border-neutral-200" />

        {/* FEATURE 2: stall POSITION (location) */}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Move className="w-4 h-4 text-[#cd2653]" />
            <h2 className="text-lg font-serif text-neutral-900">Request a different stall position</h2>
          </div>
          <p className="text-xs text-neutral-500">
            Ask to be placed in a different spot or area on the floor. You can request this even before a stall is allocated to you. This does not change your stall size.
          </p>
          {moveReq && moveReq.status === 'pending' ? (
            <StatusBox
              tone="pending"
              title="Pending: stall position request"
              body={`The organisers will take this into account when they place you.${moveReq.details ? ` You asked: “${moveReq.details}”` : ''}`}
            />
          ) : moveReq && moveReq.status === 'approved' ? (
            <StatusBox
              tone="approved"
              title="Your position request was acknowledged."
              body="The organisers have your preference. Your final position is confirmed on My Stand."
            />
          ) : (
            <>
              {moveReq && moveReq.status === 'rejected' && (
                <StatusBox tone="rejected" title="Your last position request was declined." body={moveReq.adminNote || 'You can submit a new request below.'} />
              )}
              <StallMoveForm stallCode={stallCode} zones={zones} />
            </>
          )}
        </section>
      </div>
    </div>
  )
}
