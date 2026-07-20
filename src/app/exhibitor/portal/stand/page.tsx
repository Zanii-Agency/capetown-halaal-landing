import { Info, Maximize2, Move } from 'lucide-react'
import Link from 'next/link'
import StandView from '@/components/exhibitor/StandView'
import { requireApproved } from '@/lib/exhibitor-paygate'
import { getExhibitorContext } from '@/lib/exhibitor'
import { parsePortalState } from '@/lib/portal-state'
import { parseAllocation } from '@/lib/stalls'
import PublishStallToggle from '@/components/exhibitor/PublishStallToggle'

export const dynamic = 'force-dynamic'

export default async function MyStand() {
  await requireApproved()
  const ctx = await getExhibitorContext()
  const app = ctx?.application ?? null
  const notes = (app?.admin_notes as string) || ''
  const state = parsePortalState(notes)
  const hasStall = Boolean(parseAllocation(notes).stall)
  const initialPublish = Boolean(state.profile?.publish_stall)

  return (
    <div className="bg-[#FAFAF8] -mx-4 sm:-mx-6 px-4 sm:px-6 py-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[#cd2653] font-semibold">My Stand</p>
          <h1 className="font-serif text-3xl text-neutral-900 mt-1">Where you are on the map</h1>
        </div>

        <div className="flex items-start gap-3 rounded-xl border border-[#cd2653]/20 bg-[#cd2653]/5 p-4">
          <Info className="w-5 h-5 text-[#cd2653] mt-0.5 shrink-0" />
          <p className="text-sm text-neutral-800 leading-relaxed">
            <span className="font-semibold">All outdoor food vendors and Bedouin tent vendors</span> will be allocated their position on setup day,
            not in advance. Your final position is confirmed by the organisers on site.
          </p>
        </div>

        <div className={hasStall ? 'min-h-[600px]' : ''}>
          <StandView />
        </div>

        <PublishStallToggle initialPublish={initialPublish} hasStall={hasStall} />

        {/* Stall request entry points — two distinct features, both pre-allocation */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
          <Link
            href="/exhibitor/portal/stand/change"
            className="flex items-start gap-4 rounded-xl border border-[#E5DCC4] bg-white p-4 hover:border-[#cd2653] hover:bg-[#fdf8f8] transition-colors group"
          >
            <div className="flex items-center justify-center w-10 h-10 rounded-full bg-[#cd2653]/10 shrink-0 mt-0.5">
              <Maximize2 className="w-4.5 h-4.5 text-[#cd2653]" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-neutral-900 group-hover:text-[#cd2653]">Change stall size</p>
              <p className="text-xs text-neutral-500 mt-0.5 leading-relaxed">
                Switch to a bigger or smaller booth tier. Available now, even before allocation.
                {state.stallChangeRequest?.status === 'pending' && (
                  <span className="ml-1.5 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">Pending review</span>
                )}
              </p>
            </div>
          </Link>

          <Link
            href="/exhibitor/portal/stand/change"
            className="flex items-start gap-4 rounded-xl border border-[#E5DCC4] bg-white p-4 hover:border-[#cd2653] hover:bg-[#fdf8f8] transition-colors group"
          >
            <div className="flex items-center justify-center w-10 h-10 rounded-full bg-[#cd2653]/10 shrink-0 mt-0.5">
              <Move className="w-4.5 h-4.5 text-[#cd2653]" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-neutral-900 group-hover:text-[#cd2653]">Request stall change</p>
              <p className="text-xs text-neutral-500 mt-0.5 leading-relaxed">
                Ask for a different spot or area on the floor. Available before and after allocation.
                {state.stallMoveRequest?.status === 'pending' && (
                  <span className="ml-1.5 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">Pending review</span>
                )}
              </p>
            </div>
          </Link>
        </div>
      </div>
    </div>
  )
}
