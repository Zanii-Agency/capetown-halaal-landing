import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { askFestivalBrain } from '@/lib/festival-brain'
import { getExhibitorContext } from '@/lib/exhibitor'
import type { ResolvedIdentity } from '@/lib/bot/identity'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient as createServerSupabase } from '@/lib/supabase/server'
import {
  checkHoneypot,
  checkIpThrottle,
  logGuardEvent,
  clientIp,
} from '@/lib/security/abuse-guard'
import {
  MARQUEE_CAPACITY,
  TOTAL_DEFINED_CAPACITY,
  VENUE_ZONES,
} from '@/lib/venue-zones'

const ENDPOINT = 'chat'

// Source of truth: lib/venue-zones.ts. Derived here so the admin prompt can
// never drift from the allocation map. 243 marquee (on-map) + 20 bedouin + 45
// trucks (30 food/drink + 10 dessert + 5 snack) = 308 defined vendor spots.
const ZONE_BREAKDOWN = VENUE_ZONES.map((z) => `${z.label} ${z.capacity}`).join(', ')
const TRUCK_TOTAL = VENUE_ZONES.filter((z) => z.key.endsWith('_truck')).reduce(
  (s, z) => s + z.capacity,
  0,
)
const OUTSIDE_TOTAL = TOTAL_DEFINED_CAPACITY - MARQUEE_CAPACITY
// 10 messages / IP / 10min for the public branch. Anyone past that is either
// a scraper or an LLM-burn DoS. Admin branch separately gates on session.
const MAX_PER_WINDOW = 10
const WINDOW_MIN = 10
const MAX_BODY_BYTES = 4 * 1024
const MAX_MESSAGE_CHARS = 1000

const ADMIN_PROMPT = `You are the Young at Heart Festival admin helper. You help the festival management team understand their data and make decisions.

You have access to these admin tools and pages:
- Dashboard (cthalaal.co.za/admin): KPIs, revenue trends, vendor pipeline, ticket sales charts
- Ticket Sales (/admin/tickets): WooCommerce order data, daily revenue, ticket type breakdown
- Applications (/admin/applications): vendor booth applications, approve/reject/request info
- Analytics (/admin/analytics): page views, visitors, geo data, device breakdown, referrers, vendor funnel
- Contacts (/admin/contacts): incomplete and started applications, failed payments, abandoned checkouts, captured emails from drop-offs

KEY METRICS YOU KNOW (source of truth: lib/venue-zones.ts):
- ${TOTAL_DEFINED_CAPACITY} defined vendor spots across 5 zones: ${ZONE_BREAKDOWN}.
- The Marquee (${MARQUEE_CAPACITY} stalls) is the ONLY zone that gets a floor-plan stall allocation. The other ${OUTSIDE_TOTAL} spots are outside zones (${OUTSIDE_TOTAL - TRUCK_TOTAL} bedouin + ${TRUCK_TOTAL} trucks): payment-tracked and acknowledged only, no map slot, allocated on setup day.
- Festival dates: 11, 12, 13 December 2026
- Ticket prices: R30 per day, R60 weekend pass
- Marquee stall fees are in the exhibitor portal and on the application form. Do not quote stall or truck prices from memory. If asked for a specific fee, point the team to the Applications page or the apply form rather than stating a number.

ADMIN GUIDANCE:
- When asked about revenue, refer them to Dashboard or Ticket Sales page
- When asked about vendor categories, refer to the Vendor Categories section on Dashboard
- When asked about drop-offs, refer to the Contacts page and the vendor funnel in Analytics
- When asked about approvals, guide them to Applications page
- Suggest actionable next steps based on the data
- Be concise, data-driven, and helpful

RULES:
- Be professional but friendly
- Give specific, actionable advice
- Reference exact pages and sections where they can find data
- Keep responses concise (2-3 sentences)
- No em-dashes. Use commas, periods, colons.
- Do not say "AI assistant", "Claude", "ChatGPT". You are Zanii AI for Young at Heart.`

const client = new Anthropic()

async function isAdmin(): Promise<boolean> {
  try {
    const supabase = await createServerSupabase()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return false
    const meta = user.user_metadata || {}
    return Boolean(meta.is_admin) || meta.role === 'admin'
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = createAdminClient()
    const ip = clientIp(req.headers)

    // V7: cap raw body to 4KB so an attacker cannot ship a multi-MB prompt
    // and burn the Anthropic budget on a single call.
    const raw = await req.text()
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'Body too large' }, { status: 413 })
    }
    let parsed: { messages?: Array<{ role: string; content: string }>; context?: string; [k: string]: unknown }
    try {
      parsed = JSON.parse(raw)
    } catch {
      return NextResponse.json({ error: 'Bad JSON' }, { status: 400 })
    }
    const { messages, context } = parsed

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: 'Messages required' }, { status: 400 })
    }

    // Honeypot — if there's a hidden form field, bots filling it get a soft
    // 200 so they can't fingerprint the defense.
    const hp = checkHoneypot(parsed as Record<string, unknown>)
    if (!hp.ok) {
      await logGuardEvent(admin, { endpoint: ENDPOINT, ip, reason: hp.reason!, fields: {} })
      return NextResponse.json({ message: '' })
    }

    // Cap message length. The public visitor concierge does not need 10K-char
    // turns and the admin chat only needs a few hundred.
    for (const m of messages) {
      if (typeof m?.content === 'string' && m.content.length > MAX_MESSAGE_CHARS) {
        return NextResponse.json({ error: 'Message too long' }, { status: 413 })
      }
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: 'Chat service not configured' }, { status: 503 })
    }

    const adminBranch = context === 'admin'
    const vendorBranch = context === 'vendor'

    // Admin branch: gate the LLM call behind a real admin session. Public
    // callers asking for context=admin (e.g. trying to coax vendor-data
    // answers out of the prompt) get rejected at the door.
    if (adminBranch) {
      if (!(await isAdmin())) {
        return NextResponse.json({ error: 'Not authorised' }, { status: 401 })
      }
    } else if (vendorBranch) {
      // Vendor branch: ONLY a signed-in exhibitor gets vendor-platform answers.
      // A public caller POSTing context='vendor' has no exhibitor session, so
      // they're rejected — vendor answers never leak off the portal.
      const exhibitor = await getExhibitorContext()
      if (!exhibitor) {
        return NextResponse.json({ error: 'Not authorised' }, { status: 401 })
      }
      const last = messages[messages.length - 1]
      const history = messages
        .slice(0, -1)
        .slice(-8)
        .map((m: { role: string; content: string }) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }))
      const assistantHasSpoken = messages.some((m: { role: string }) => m.role === 'assistant')
      const appRow = (exhibitor.application || {}) as Record<string, unknown>

      // The portal caller is an AUTHENTICATED vendor (their session = their
      // application). Build the SAME rich identity briefing the WhatsApp bot uses
      // so the in-portal assistant answers tailored to THIS vendor: their real
      // status, contract, payment, allocated stall, and a deterministic NEXT STEP.
      // We also append the exact amount owed/paid/outstanding so it can tell them
      // precisely what to pay. No phone is needed: identity is the session.
      const { parsePortalState } = await import('@/lib/portal-state')
      const { parseAllocation, tierLabel } = await import('@/lib/stalls')
      const { identityBriefing } = await import('@/lib/bot/identity')
      const { computeVendorPricing, formatRand } = await import('@/lib/payments/pricing')

      const portal = parsePortalState((appRow.admin_notes as string) || null)
      const alloc = parseAllocation((appRow.admin_notes as string) || null)
      const vName = (appRow.contact_name as string) || (appRow.business_name as string) || null
      const identity: ResolvedIdentity = {
        role: 'vendor',
        name: vName,
        firstName: (vName || '').trim().split(/\s+/)[0] || null,
        e164: '',
        vendor: {
          id: (appRow.id as string) || '',
          business_name: (appRow.business_name as string) || '',
          contact_name: (appRow.contact_name as string) || null,
          email: (appRow.email as string) || null,
          status: (appRow.status as string) || 'pending',
          stall: alloc.stall,
          payment_status: portal.payment?.status || 'none',
          tier_label: appRow.preferred_booth_tier ? tierLabel(appRow.preferred_booth_tier as string) : null,
          contract_signed_at: (appRow.contract_signed_at as string) || null,
        },
      }
      const owed = computeVendorPricing({
        preferred_booth_tier: appRow.preferred_booth_tier as string,
        special_requirements: appRow.special_requirements,
      }).total
      const paid = Number(portal.payment?.amount) || 0
      const outstanding = Math.max(0, owed - paid)
      const moneyLine = `Stall fee: total ${formatRand(owed)}, paid ${formatRand(paid)}, outstanding ${formatRand(outstanding)}. If they ask what to pay, the amount due now is ${formatRand(outstanding)}, payable by card in the portal.`
      const brief = `${identityBriefing(identity)}\n\n${moneyLine}`

      const result = await askFestivalBrain(last?.content ?? '', {
        history,
        forceFirstContact: !assistantHasSpoken,
        surface: 'vendor',
        extraSystem: brief,
      })
      return NextResponse.json({ message: result.message, needsHuman: result.needsHuman })
    } else {
      // Public branch: per-IP throttle.
      const throttle = await checkIpThrottle(admin, {
        ip,
        endpoint: ENDPOINT,
        max: MAX_PER_WINDOW,
        windowMin: WINDOW_MIN,
      })
      if (!throttle.ok) {
        await logGuardEvent(admin, { endpoint: ENDPOINT, ip, reason: throttle.reason!, fields: {} })
        return NextResponse.json(
          { message: 'You are sending messages too quickly. Try again in a minute.' },
          { status: 429 },
        )
      }
      await logGuardEvent(admin, {
        endpoint: ENDPOINT,
        ip,
        reason: 'rate_limited',
        fields: { kind: 'attempt' },
      })

      const last = messages[messages.length - 1]
      const history = messages
        .slice(0, -1)
        .slice(-8)
        .map((m: { role: string; content: string }) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }))

      // Web chat = treat each new session as first-contact for sign-off purposes
      // if the assistant has not sent anything yet in this thread.
      const assistantHasSpoken = messages.some(
        (m: { role: string }) => m.role === 'assistant',
      )

      const result = await askFestivalBrain(last?.content ?? '', {
        history,
        forceFirstContact: !assistantHasSpoken,
      })

      return NextResponse.json({
        message: result.message,
        needsHuman: result.needsHuman,
      })
    }

    // Admin chat: direct LLM with admin prompt.
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      temperature: 0,
      system: ADMIN_PROMPT,
      messages: messages.slice(-10).map((m: { role: string; content: string }) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    })

    const text = response.content[0].type === 'text' ? response.content[0].text : ''

    return NextResponse.json({ message: text })
  } catch (error) {
    console.error('Chat error:', error)
    return NextResponse.json({ error: 'Failed to process message' }, { status: 500 })
  }
}
