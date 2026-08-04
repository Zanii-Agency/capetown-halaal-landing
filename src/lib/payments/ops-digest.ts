// Daily ops pulse for the master (Taona): who opened the portal today, who paid,
// and where the per-tier Yoco/EFT rotation stands. MASTER ONLY: the rotation and
// payment posture are walled off from the festival owner (delivered through
// notifyOwners({audience:'master'}), which also excludes her on any EFT mention).
//
// Reuses what already exists rather than adding a second tracker:
//   - opens come from the `vendor_active` events pingVendorActivity already
//     writes on portal load (deduped 12h/vendor);
//   - rotation reads the SAME functions the vendor payment page routes on
//     (getRotationStartAt / tierReceivedCount / tierRotationSaysEft), so the
//     digest can never disagree with what a vendor is actually shown.

import { createAdminClient } from '@/lib/supabase/admin'
import { TIER_META, SMALL_EFT_ROTATION_TIERS } from '@/lib/stalls'
import { getRotationStartAt, tierReceivedCount, tierRotationSaysEft } from '@/lib/eft'
import { parsePortalState } from '@/lib/portal-state'
import { formatRand } from '@/lib/payments/pricing'
import { isTestVendor } from '@/lib/test-vendors'

export interface TierRotation {
  slug: string
  label: string
  isSmall: boolean
  /** payments received in this tier since the rotation start line */
  received: number
  /** any approved, still-unpaid vendor remains in this tier (a payment is live) */
  hasPending: boolean
  /** what the next 3 payers in this tier will be routed to */
  nextThree: Array<'yoco' | 'eft'>
}

export interface RotationState {
  activated: boolean
  startedAt: string | null
  tiers: TierRotation[]
}

export interface PaidToday { who: string; amount: number; method: string }

export interface OpsDigest {
  dateLabel: string
  opensToday: { count: number; names: string[] }
  paymentsToday: PaidToday[]
  paidTotal: number
  rotation: RotationState
}

const JHB = 'Africa/Johannesburg'

// 00:00 SAST for `now`'s SAST calendar day, expressed as a UTC ISO string. SAST
// is UTC+2, no DST, so the shift is a fixed 2h. The digest fires at 20:00 SAST,
// so "today" is the SAST day, not the UTC day.
function sastDayStartIso(now: Date): string {
  const sast = new Date(now.getTime() + 2 * 3600 * 1000)
  sast.setUTCHours(0, 0, 0, 0)
  return new Date(sast.getTime() - 2 * 3600 * 1000).toISOString()
}

export async function buildRotationState(): Promise<RotationState> {
  const startedAt = await getRotationStartAt()
  const admin = createAdminClient()

  // approved + unpaid vendors per tier -> which tiers have a live next-payer.
  const pendingByTier = new Map<string, number>()
  {
    const { data } = await admin
      .from('vendor_applications')
      .select('preferred_booth_tier, paid_at, admin_notes, business_name, email')
      .eq('status', 'approved')
    for (const r of (data || []) as Array<Record<string, unknown>>) {
      if (r.paid_at) continue
      if (isTestVendor({ business_name: r.business_name as string, email: r.email as string })) continue
      if (parsePortalState((r.admin_notes as string) || '').payment?.status === 'paid') continue
      const t = (r.preferred_booth_tier as string) || ''
      pendingByTier.set(t, (pendingByTier.get(t) || 0) + 1)
    }
  }

  const tiers = await Promise.all(
    Object.keys(TIER_META).map(async (slug): Promise<TierRotation> => {
      const received = startedAt ? await tierReceivedCount(slug, startedAt) : 0
      const nextThree = [0, 1, 2].map(
        (i) => (tierRotationSaysEft(received + i, slug) ? 'eft' : 'yoco') as 'yoco' | 'eft',
      )
      return {
        slug,
        label: TIER_META[slug].label,
        isSmall: SMALL_EFT_ROTATION_TIERS.has(slug),
        received,
        hasPending: (pendingByTier.get(slug) || 0) > 0,
        nextThree,
      }
    }),
  )

  return { activated: !!startedAt, startedAt, tiers }
}

export async function buildOpsDigest(now: Date = new Date()): Promise<OpsDigest> {
  const admin = createAdminClient()
  const dayStart = sastDayStartIso(now)

  // Opens: the vendor_active events pingVendorActivity already writes. Distinct
  // application_id = distinct vendors who opened the portal today.
  const opens = new Map<string, string>()
  {
    const { data } = await admin
      .from('site_events')
      .select('metadata, created_at')
      .eq('event_type', 'vendor_active')
      .gte('created_at', dayStart)
      .order('created_at', { ascending: false })
    for (const e of (data || []) as Array<{ metadata: { application_id?: string; business_name?: string; actor?: string } | null }>) {
      const id = e.metadata?.application_id
      if (!id || opens.has(id)) continue
      const business_name = e.metadata?.business_name || ''
      if (isTestVendor({ business_name, email: e.metadata?.actor })) continue
      opens.set(id, business_name.trim() || 'A vendor')
    }
  }

  // Payments received today via EITHER rail: a Yoco paid_at, or an EFT collection.
  const paymentsToday: PaidToday[] = []
  {
    const rows: Array<Record<string, unknown>> = []
    for (let from = 0; ; from += 1000) {
      const { data } = await admin
        .from('vendor_applications')
        .select('business_name, paid_at, admin_notes, email')
        .range(from, from + 999)
      if (!data || !data.length) break
      rows.push(...(data as Array<Record<string, unknown>>))
      if (data.length < 1000) break
    }
    for (const r of rows) {
      if (isTestVendor({ business_name: r.business_name as string, email: r.email as string })) continue
      const p = parsePortalState((r.admin_notes as string) || '').payment
      const paidAt = r.paid_at as string | null
      const collAt = p?.eft_collected_at
      const who = ((r.business_name as string) || 'A vendor').trim()
      const amount = Number(p?.amount) || 0
      if (paidAt && paidAt >= dayStart) paymentsToday.push({ who, amount, method: (p?.method as string) || 'yoco' })
      else if (typeof collAt === 'string' && collAt >= dayStart) paymentsToday.push({ who, amount, method: 'eft' })
    }
  }

  return {
    dateLabel: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: JHB }).format(now),
    opensToday: { count: opens.size, names: [...opens.values()] },
    paymentsToday,
    paidTotal: paymentsToday.reduce((s, p) => s + p.amount, 0),
    rotation: await buildRotationState(),
  }
}

const METHOD_WORD: Record<string, string> = { yoco: 'Yoco', eft: 'EFT', cash: 'cash', manual: 'manual', manual_card: 'card', waived: 'waived', fnb: 'EFT' }
export function methodWord(m: string): string { return METHOD_WORD[m] || m }

function cap(list: string[], n: number): string {
  return list.length <= n ? list.join(', ') : `${list.slice(0, n).join(', ')} +${list.length - n} more`
}

// Deterministic structured -> WhatsApp-native: bold headers, bullets, blank-line
// spacing. NOT prose reused from the web surface (ca-errors 2026-07-13: a channel
// push is not the in-app view). No em/en dashes (Law 7; sendText's sanitiser is a
// backstop, not a licence to emit them).
export function formatOpsDigestWa(d: OpsDigest): string {
  const L: string[] = [`*CTH daily pulse* · ${d.dateLabel}`, '']

  if (d.paymentsToday.length) {
    L.push(`*Paid today: ${d.paymentsToday.length}* (${formatRand(d.paidTotal)})`)
    for (const p of d.paymentsToday.slice(0, 8)) L.push(`• ${p.who}: ${formatRand(p.amount)} ${methodWord(p.method)}`)
    if (d.paymentsToday.length > 8) L.push(`• +${d.paymentsToday.length - 8} more`)
  } else {
    L.push('*Paid today: 0*')
  }
  L.push('')

  L.push(`*Opened portal today: ${d.opensToday.count}*`)
  if (d.opensToday.count) L.push(cap(d.opensToday.names, 8))
  L.push('')

  if (!d.rotation.activated) {
    L.push('*Payment rotation:* not activated')
  } else {
    L.push('*Payment rotation* (next payer per tier)')
    const active = d.rotation.tiers.filter((t) => t.hasPending)
    if (!active.length) L.push('• no approved vendors awaiting payment')
    else for (const t of active) L.push(`• ${t.label}: ${methodWord(t.nextThree[0])}`)
  }

  return L.join('\n')
}
