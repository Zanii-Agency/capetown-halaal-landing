// Tool-call audit receipts (ADR-0005 invariant 4). Every tool call writes
// {waPhone, tool, vendorId, ok, detail} to site_events BEFORE the reply is sent.
// This is the forensic record proving the isolation guarantees held in prod.
//
// We await the insert inline (a single fast row) so the receipt is durable
// without depending on Vercel's waitUntil/after; the webhook additionally runs
// deferred work in after(). Best-effort: a receipt failure must never block or
// break a tool call, but it IS logged (a silent audit gap is itself a defect).

import { createAdminClient } from '@/lib/supabase/admin'

export interface ToolReceipt {
  waPhone: string
  tool: string
  vendorId: string | null   // the SESSION vendorId the call was scoped to (null when unverified)
  ok: boolean
  detail?: string           // short reason / summary; never raw PII
}

export async function writeToolReceipt(r: ToolReceipt): Promise<void> {
  try {
    const db = createAdminClient()
    await db.from('site_events').insert({
      session_id: 'bot_tool_call',
      event_type: 'bot_tool_call',
      path: '/lib/bot/tools',
      metadata: {
        wa_phone_last4: r.waPhone.slice(-4),  // never store the full number in the audit metadata
        tool: r.tool,
        vendor_id: r.vendorId,
        ok: r.ok,
        detail: r.detail || null,
        at: new Date().toISOString(),
      },
    })
  } catch (e) {
    console.error('[tool-audit] receipt write failed:', (e as Error).message)
  }
}
