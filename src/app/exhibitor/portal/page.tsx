import { redirect } from 'next/navigation'
import { getExhibitorContext } from '@/lib/exhibitor'
import { parsePortalState } from '@/lib/portal-state'
import { parseAllocation, tierLabel, TYPE_META, STALL_LIST, type StallType } from '@/lib/stalls'
import { listAnnouncements } from '@/lib/announcements'
import Link from 'next/link'
import {
  Calendar, MapPin, FileCheck, Users, CreditCard, Store, CheckCircle2, Circle,
  ArrowRight, Megaphone, Upload, Share2, type LucideIcon,
} from 'lucide-react'
import { vendorSlug } from '@/lib/slugify'
import { Gauge } from '@/components/exhibitor/Gauge'
import { PageShell, PageHeader, Card } from '@/components/chrome/PageChrome'
import { requirePaid } from '@/lib/exhibitor-paygate'
import { getRequiredDocs } from '@/lib/exhibitor/required-docs'
import TaskChecklist from '@/components/exhibitor/TaskChecklist'
import WelcomeModal from '@/components/exhibitor/WelcomeModal'
import LogoUploadModal from '@/components/exhibitor/LogoUploadModal'

export const dynamic = 'force-dynamic'

const STAGES = ['approved', 'invoiced', 'paid', 'docs', 'show_ready'] as const
const STAGE_LABEL: Record<string, string> = { approved: 'Approved', invoiced: 'Invoiced', paid: 'Paid', docs: 'Documents', show_ready: 'Show-ready' }

function daysUntil(d: string) { return Math.max(0, Math.ceil((new Date(d).getTime() - Date.now()) / 86400000)) }

function ActionCard({ href, label, icon: Icon, disabled, external }: {
  href: string; label: string; icon: any; disabled?: boolean; external?: boolean
}) {
  const classes = "flex flex-col items-center justify-center gap-2 rounded-2xl border border-[#E5DCC4] bg-white p-4 text-sm font-medium text-neutral-700 hover:border-[#cd2653] hover:text-[#cd2653] transition-colors"
  if (disabled) return <div className={`${classes} opacity-40 cursor-not-allowed`}>{Icon && <Icon className="w-5 h-5" />}{label}</div>
  if (external) return <a href={href} target="_blank" rel="noopener" className={classes}>{Icon && <Icon className="w-5 h-5" />}{label}</a>
  return <Link href={href} className={classes}>{Icon && <Icon className="w-5 h-5" />}{label}</Link>
}

function StatTile({ icon: Icon, value, label, href, accent }: { icon: LucideIcon; value: string; label: string; href: string; accent?: boolean }) {
  return (
    <a href={href} className={`group rounded-2xl p-4 border transition-colors ${accent ? 'bg-[#cd2653] border-[#cd2653] text-white' : 'bg-[#FDFAF1] border-[#B8924A]/40 hover:border-[#cd2653]/50'}`}>
      <Icon className={`w-4 h-4 mb-3 ${accent ? 'text-white/80' : 'text-[#cd2653]'}`} />
      <p className={`font-serif text-2xl leading-tight ${accent ? 'text-white' : 'text-[#1B1A17]'}`}>{value}</p>
      <p className={`text-xs mt-0.5 ${accent ? 'text-white/70' : 'text-[#1B1A17]/55'}`}>{label}</p>
    </a>
  )
}

export default async function Overview() {
  // Contract sign gate fires BEFORE paid-check. Sign comes before pay.
  // Path-detection in Next 16 layouts is unreliable, so we gate here at the
  // page boundary instead of in the layout. /portal/contract has no gate of
  // its own, so the sign page is always reachable from the redirect.
  const gateCtx = await getExhibitorContext()
  const gateApp = gateCtx?.application as any
  if (gateApp?.status === 'approved' && !gateApp?.contract_signed_at) {
    redirect('/exhibitor/portal/contract')
  }

  await requirePaid()
  const ctx = await getExhibitorContext()
  const app = ctx?.application ?? null
  const notes = (app?.admin_notes as string) || ''
  const state = parsePortalState(notes)
  const business = (app?.business_name as string) || 'Exhibitor'
  const tier = tierLabel(app?.preferred_booth_tier as string | undefined)

  // live readiness signals
  const stall = parseAllocation(notes).stall
  const stallZone = stall ? TYPE_META[(STALL_LIST.find((s) => s.code === stall)?.type || 'FS') as StallType].label : null
  const docTypes = new Set((state.docs || []).map((d) => d.type))
  const productCategories = Array.isArray(app?.product_categories) ? (app!.product_categories as string[]) : []
  const requiredDocs = getRequiredDocs({
    productCategories,
    boothTier: (app?.preferred_booth_tier as string) || null,
  })
  const docsUploaded = requiredDocs.length === 0 ? 0 : requiredDocs.filter((t) => docTypes.has(t)).length
  const docsLabel = requiredDocs.length === 0 ? 'no docs required' : 'documents in'
  const docsTileValue = requiredDocs.length === 0 ? '—' : `${docsUploaded}/${requiredDocs.length}`
  const staffCount = (state.staff || []).length
  const isPaid = state.payment?.status === 'paid' || app?.payment_status === 'paid'
  const profileLive = !!(state.profile?.logo_path || state.profile?.description)
  const paymentDue = (app?.payment_due_date as string) || '1 Sep 2026'

  const termsAccepted = !!state.terms_accepted_at
  const contractSigned = !!app?.contract_signed_at
  const steps = [
    { done: true, label: 'Application approved', sub: 'Welcome to the festival', href: '/exhibitor/portal' },
    { done: termsAccepted, label: 'Accept terms & conditions', sub: termsAccepted ? 'Recorded against your account' : 'Required before payment', href: '/exhibitor/portal/terms' },
    { done: contractSigned, label: 'Sign vendor contract', sub: contractSigned ? 'Vendor Contract 2026 signed' : 'Locks your stall fee and your spot.', href: '/exhibitor/portal/contract' },
    { done: isPaid, label: 'Pay your stall fee', sub: isPaid ? 'Received, thank you' : `Due ${paymentDue}`, href: '/exhibitor/portal/payments' },
    { done: !!stall, label: 'Stall allocated', sub: stall ? `${stall} · ${stallZone}` : 'Organisers will place you', href: '/exhibitor/portal/stand' },
    {
      done: requiredDocs.length === 0 || docsUploaded === requiredDocs.length,
      label: 'Upload compliance documents',
      sub: requiredDocs.length === 0 ? 'None required for your category' : `${docsUploaded} of ${requiredDocs.length} uploaded`,
      href: '/exhibitor/portal/documents',
    },
    { done: staffCount > 0, label: 'Register your gate staff', sub: staffCount ? `${staffCount} on the manifest` : 'Names, phone, vehicle', href: '/exhibitor/portal/staff' },
  ]
  const doneCount = steps.filter((s) => s.done).length
  const readiness = Math.round((doneCount / steps.length) * 100)

  const SECTOR_TO_SLUG: Record<string, string> = {
    'Food & Beverage': 'food-beverage',
    'Fashion & Modest Wear': 'fashion-modest-wear',
    'Beauty & Wellness': 'beauty-wellness',
    'Health & Pharmacy': 'health-pharmacy',
    'Travel & Tourism': 'travel-tourism',
    'Home & Living': 'home-living',
    'Finance & Services': 'finance-services',
    'Business & Trade': 'business-trade',
  }
  const sectorSlug = productCategories.find(c => SECTOR_TO_SLUG[c]) || null
  const publicProfileUrl = profileLive && sectorSlug
    ? `https://cthalaal.co.za/sectors/${sectorSlug}/${vendorSlug(business)}`
    : null

  // stage for the pipeline
  const stage = (state.stage as string) || (isPaid ? 'paid' : (app?.payment_status === 'deferred' ? 'invoiced' : 'approved'))
  const stageIdx = STAGES.indexOf(stage as typeof STAGES[number])
  const dDay = daysUntil('2026-12-11')
  const announcement = (await listAnnouncements())[0]
  const contactName = (app?.contact_name as string) || ''
  const firstName = (contactName.trim().split(/\s+/)[0]) || business

  return (
    <PageShell>
      {/* First-login welcome modal. Client component, gated by localStorage flag
          cth_portal_welcomed. No server marker exists for "vendor was welcomed"
          on this Supabase instance (grep confirmed), so the server hint is
          always false and the client flag is the source of truth. */}
      <WelcomeModal firstName={firstName} alreadyDismissedServer={false} />

      {/* Logo-upload nudge: only for vendors who have PAID but have no logo yet,
          so they go live with branding in the public sector listings. Server
          decides eligibility here; the client component owns show-once-per-session. */}
      {isPaid && !state.profile?.logo_path && <LogoUploadModal firstName={firstName} />}

      <PageHeader
        kicker="Exhibitor portal"
        title={business}
        subtitle={`${tier} · application ${String(app?.status ?? 'pending')}`}
      />

      <div className="space-y-7">
        {/* Self-service checklist. Mounted ABOVE the existing dashboard so the
            "what do I need to do next?" signal lands first. Existing gauge,
            bento, pipeline and announcement card stay below, unchanged. */}
        <TaskChecklist />

        {/* readiness gauge + stat bento */}
        <div className="grid md:grid-cols-[248px_1fr] gap-4">
          <Card className="flex flex-col items-center justify-center text-center">
            <Gauge pct={readiness} label={`${readiness}%`} sublabel="show-ready" />
            <p className="text-sm font-medium text-[#1B1A17]/70 mt-4">{doneCount} of {steps.length} steps done</p>
            <p className="text-xs text-[#1B1A17]/45 mt-0.5">Finish the checklist below</p>
          </Card>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 content-start">
            <StatTile icon={Calendar} value={`${dDay}`} label="days to opening" href="/exhibitor/portal/resources" accent />
            <StatTile icon={MapPin} value={stall || 'Pending'} label={stall ? (stallZone || 'your stall') : 'stall not set'} href="/exhibitor/portal/stand" />
            <StatTile icon={FileCheck} value={docsTileValue} label={docsLabel} href="/exhibitor/portal/documents" />
            <StatTile icon={Users} value={`${staffCount}`} label="team registered" href="/exhibitor/portal/staff" />
            <StatTile icon={CreditCard} value={isPaid ? 'Paid' : 'Due'} label={isPaid ? 'stall fee' : paymentDue} href="/exhibitor/portal/payments" />
            <StatTile icon={Store} value={profileLive ? 'Live' : 'Set up'} label="public profile" href="/exhibitor/portal/profile" />
          </div>
        </div>

        {/* Quick actions */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <ActionCard href="/exhibitor/portal/payments" label="Pay Now"
            icon={CreditCard} disabled={isPaid} />
          <ActionCard href="/exhibitor/portal/documents" label="Upload Docs"
            icon={Upload} />
          <ActionCard href="/exhibitor/portal/stand" label="View My Stand"
            icon={MapPin} />
          <ActionCard href={publicProfileUrl || '#'} label="Share My Profile"
            icon={Share2} external />
        </div>

        {/* status pipeline */}
        <Card>
          <p className="font-semibold text-[#1B1A17] mb-5">Your journey to show day</p>
          <div className="flex items-center">
            {STAGES.map((s, i) => {
              const done = i < stageIdx, current = i === stageIdx
              return (
                <div key={s} className="flex-1 flex items-center last:flex-none">
                  <div className="flex flex-col items-center gap-1.5">
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold ${done ? 'bg-[#cd2653] text-white' : current ? 'bg-[#cd2653]/10 text-[#cd2653] ring-2 ring-[#cd2653]' : 'bg-[#F2EBD8] text-[#1B1A17]/40'}`}>
                      {done ? <CheckCircle2 className="w-5 h-5" /> : i + 1}
                    </div>
                    <span className={`text-[11px] font-medium ${current ? 'text-[#cd2653]' : 'text-[#1B1A17]/55'}`}>{STAGE_LABEL[s]}</span>
                  </div>
                  {i < STAGES.length - 1 && <div className={`flex-1 h-0.5 mx-1 mb-5 ${done ? 'bg-[#cd2653]' : 'bg-[#E5DCC4]'}`} />}
                </div>
              )
            })}
          </div>
        </Card>

        {/* next steps + announcement */}
        <div className="grid md:grid-cols-5 gap-6">
          <div className="md:col-span-3 space-y-6">
            <Card>
              <p className="font-semibold text-[#1B1A17] mb-4">What to do next</p>
              <ul className="space-y-1">
                {steps.map((a) => (
                  <li key={a.label}>
                    <a href={a.href} className="flex items-start gap-3 -mx-2 px-2 py-2 rounded-lg hover:bg-[#F2EBD8]/60 group">
                      {a.done ? <CheckCircle2 className="w-5 h-5 text-[#cd2653] mt-0.5 shrink-0" /> : <Circle className="w-5 h-5 text-[#1B1A17]/25 mt-0.5 shrink-0" />}
                      <div className="flex-1">
                        <p className={`text-sm font-medium ${a.done ? 'text-[#1B1A17]/40 line-through' : 'text-[#1B1A17]'}`}>{a.label}</p>
                        <p className="text-xs text-[#1B1A17]/55">{a.sub}</p>
                      </div>
                      {!a.done && <ArrowRight className="w-4 h-4 text-[#1B1A17]/25 group-hover:text-[#cd2653] mt-0.5" />}
                    </a>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          <div className="md:col-span-2 space-y-4">
            <Card>
              <div className="flex items-center gap-2 text-[#cd2653] mb-3"><Megaphone className="w-4 h-4" /><span className="text-xs uppercase tracking-wide font-semibold">Latest update</span></div>
              {announcement ? (
                <a href="/exhibitor/portal/announcements" className="block group">
                  <p className="font-semibold text-[#1B1A17] text-sm group-hover:text-[#cd2653]">{announcement.title}</p>
                  <p className="text-sm text-[#1B1A17]/70 mt-1 line-clamp-3">{announcement.body}</p>
                  <p className="text-xs text-[#1B1A17]/45 mt-2">{new Date(announcement.created_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long' })}</p>
                </a>
              ) : (
                <p className="text-sm text-[#1B1A17]/55">No announcements yet. Festival updates appear here.</p>
              )}
            </Card>
            <Card className="text-sm">
              <div className="flex items-start gap-3"><Calendar className="w-4 h-4 text-[#cd2653] mt-0.5" /><div><p className="font-medium text-[#1B1A17]">11 to 13 December 2026</p><p className="text-[#1B1A17]/55 text-xs">Youngsfield Military Base</p></div></div>
            </Card>
          </div>
        </div>
      </div>
    </PageShell>
  )
}