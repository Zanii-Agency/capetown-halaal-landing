// The brain mesh (ADR-004).
//
// Sasa's mesh is INTENT-partitioned: one operator, route by message content.
// CTH is IDENTITY-partitioned: many people, route by WHO is speaking. So
// `resolveIdentity` IS the router and this dispatcher just names the brains and
// hands each sender to the one scoped to their role:
//
//   admin        → adminBrain     (broad org tools — handleAdminMessage)
//   vendor       → vendorBrain     (scoped self-service actions + Q&A)
//   ticket_buyer → attendeeBrain   (read-only festival Q&A)
//   unknown      → attendeeBrain   (read-only festival Q&A)
//
// Isolation: a brain only ever receives the resolved identity for its own role.
// The vendor brain hard-binds every write to `identity.vendor.id`; it cannot be
// handed another vendor's scope. There is no monolith fallback (Sasa rule): an
// unroutable message is an honest error, not a guess.
//
// NOTE: the admin path keeps its dedicated handling in the webhook (swipe-reply
// to handover alerts, master-forwarding) — `adminBrain` is exported here for a
// future unification but the webhook routes admins before reaching this mesh.

import type { ResolvedIdentity } from '@/lib/bot/identity'
import { identityBriefing } from '@/lib/bot/identity'
import { askFestivalBrain } from '@/lib/festival-brain'
import { handleAdminMessage } from '@/lib/bot/admin-chat'
import type { BotAdmin } from '@/lib/bot/admins'
import { runVendorBrain } from '@/lib/bot/brains/vendor-brain'

export interface BrainTurn {
  message: string
  /** Which brain answered. Logged for observability, never user-visible. */
  brain: 'admin' | 'vendor' | 'attendee'
  /** Sub-path inside the brain (e.g. vendor 'action' vs 'question'). */
  path?: string
  event?: string
  /** Slow follow-up the webhook runs after the 200 (e.g. deliver a PDF file). */
  deferred?: () => Promise<void>
}

export interface BrainCtx {
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
}

/** Admin brain — broad org tools. Thin wrapper over the existing handler so the
 *  three brains read symmetrically. (Webhook still owns swipe-reply pre-step.) */
export async function adminBrain(admin: BotAdmin, message: string): Promise<{ reply: string | null }> {
  return handleAdminMessage(admin, message)
}

/** Attendee brain — read-only festival Q&A for ticket buyers and the public. */
async function attendeeBrain(identity: ResolvedIdentity, message: string, ctx: BrainCtx): Promise<BrainTurn> {
  const result = await askFestivalBrain(message, {
    waId: identity.e164,
    history: ctx.history,
    extraSystem: identityBriefing(identity),
  })
  return { message: result.message, brain: 'attendee', path: result.trace.pathTaken }
}

/**
 * Route a NON-ADMIN inbound to its brain. Admins are handled in the webhook
 * before this is called. Returns the reply text + which brain produced it.
 */
export async function routeToBrain(
  identity: ResolvedIdentity,
  message: string,
  ctx: BrainCtx = {},
): Promise<BrainTurn> {
  if (identity.role === 'vendor') {
    const r = await runVendorBrain(identity, message, ctx)
    return { message: r.message, brain: 'vendor', path: r.path, event: r.event, deferred: r.deferred }
  }
  // ticket_buyer | unknown → attendee brain.
  return attendeeBrain(identity, message, ctx)
}
