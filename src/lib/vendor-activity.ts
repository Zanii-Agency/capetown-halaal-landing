// What a vendor has done on the portal, and what went wrong for them.
//
// Taona 2026-07-29: "make sure when a vendor logs in tell me with thir ip and
// give a suumarry of thir actions on the platforms including issues they met
// with".
//
// The alert has to be readable on a phone in one glance, so this returns a
// handful of short lines, not a data dump. The ISSUES matter more than the
// actions: a vendor logging in for the fourth time after three declined card
// attempts is the one worth a call, and that is the line that has to survive
// being skimmed.
//
// Pure over already-fetched rows, so the summary is testable without Supabase
// and without a live login.

export interface VendorActivityInput {
  /** Portal state payment block. */
  payment?: {
    status?: string | null
    attempts?: number | null
    failed_attempts?: number | null
    attempted_at?: string | null
    eft_revealed_at?: string | null
    eft_submitted_at?: string | null
    amount?: number | null
  } | null
  contractSignedAt?: string | null
  termsAcceptedAt?: string | null
  docsUploaded?: number
  docsRequired?: number
  staffCount?: number
  logoUploaded?: boolean
  stallCode?: string | null
  /** Portal events for this vendor, newest first. */
  events?: { event_type: string; created_at: string }[]
  /** Their own inbound messages, newest first, for "what did they ask". */
  inbound?: { body: string | null; created_at: string }[]
  /** Prior logins, so we can say "3rd login" and "first since Monday". */
  priorLogins?: { at: string }[]
  dueDate?: Date | null
  daysToDue?: number | null
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

/** Things that went WRONG for this vendor. Ordered worst first, because the
 *  alert truncates and the top line is the one that gets read. */
export function vendorIssues(v: VendorActivityInput): string[] {
  const out: string[] = []
  const p = v.payment || {}

  const failed = Number(p.failed_attempts || 0)
  const attempts = Number(p.attempts || 0)
  const isPaid = p.status === 'paid' || p.status === 'collected'

  // A vendor who tried and could not pay is the highest-value signal on this
  // whole list: they WANT to pay and the system is in their way.
  if (!isPaid && failed > 0) out.push(`${plural(failed, 'failed payment attempt')}, still unpaid`)
  else if (!isPaid && attempts > 0) out.push(`tried to pay ${plural(attempts, 'time')}, still unpaid`)

  if (!isPaid && v.daysToDue !== null && v.daysToDue !== undefined) {
    if (v.daysToDue < 0) out.push(`payment ${plural(Math.abs(v.daysToDue), 'day')} OVERDUE`)
    else if (v.daysToDue <= 7) out.push(`payment due in ${plural(v.daysToDue, 'day')}`)
  }

  if (p.eft_submitted_at && !isPaid) out.push('uploaded a proof that is still unreconciled')

  // Contract stays: 42% of approved vendors have not signed, and an unsigned
  // contract BLOCKS payment, so it explains why they are stuck.
  if (!v.contractSignedAt) out.push('has not signed the contract')

  // TERMS AND DOCUMENTS ARE DELIBERATELY NOT ISSUES. Measured across the 171
  // approved vendors on 2026-07-29: 96% have no terms_accepted_at and 97% have
  // uploaded no documents. A line that appears on 24 out of every 25 alerts
  // carries no information, it just teaches the reader to skim past the Issues
  // block, which is where the failed-payment line lives.
  //
  // Document progress is still reported, under Progress where it belongs.
  // Re-add either of these as an ISSUE only if the underlying rate changes.

  // Asking for a human is an explicit statement that the portal did not answer
  // them, so it counts as an issue and not as an action.
  const asked = (v.events || []).filter((e) => /needs_human|support|stall_(change|move)_requested/i.test(e.event_type)).length
  if (asked > 0) out.push(`${plural(asked, 'unresolved request')} raised`)

  return out
}

/** Things the vendor has DONE. Progress, not problems. */
export function vendorActions(v: VendorActivityInput): string[] {
  const out: string[] = []
  const p = v.payment || {}
  if (p.status === 'paid') out.push('paid')
  else if (p.status === 'collected') out.push('payment received, awaiting reconcile')
  if (v.contractSignedAt) out.push('contract signed')
  if (v.termsAcceptedAt) out.push('terms accepted')
  if (v.stallCode) out.push(`stall ${v.stallCode}`)
  const req = Number(v.docsRequired || 0), up = Number(v.docsUploaded || 0)
  if (up > 0) out.push(`${up}${req ? `/${req}` : ''} docs`)
  if (Number(v.staffCount || 0) > 0) out.push(`${plural(Number(v.staffCount), 'staff member')}`)
  if (v.logoUploaded) out.push('logo up')
  return out
}

/** Nth login, and how long since the last one. */
export function loginContext(priorLogins: { at: string }[] | undefined, now = Date.now()): string {
  const list = (priorLogins || []).slice().sort((a, b) => b.at.localeCompare(a.at))
  const n = list.length + 1
  const ord = n === 1 ? 'first login' : n === 2 ? '2nd login' : n === 3 ? '3rd login' : `${n}th login`
  if (!list.length) return ord
  const hrs = (now - new Date(list[0].at).getTime()) / 3_600_000
  if (!Number.isFinite(hrs)) return ord
  const since = hrs < 1 ? 'minutes ago' : hrs < 48 ? `${Math.round(hrs)}h ago` : `${Math.round(hrs / 24)}d ago`
  return `${ord}, last was ${since}`
}

/** The WhatsApp body. Kept to a phone screen: who, where, why it matters.
 *  Issues come BEFORE actions because the alert can be truncated by the
 *  transport and the truncated version still has to be worth reading. */
export function buildLoginAlert(args: {
  businessName: string
  contactName?: string | null
  place: string
  ip: string | null
  activity: VendorActivityInput
}): string {
  const issues = vendorIssues(args.activity)
  const actions = vendorActions(args.activity)
  const who = args.contactName ? `${args.businessName} (${args.contactName})` : args.businessName

  const lines = [
    `*${who}* just logged in.`,
    `${args.place}${args.ip ? ` · ${args.ip}` : ''} · ${loginContext(args.activity.priorLogins)}`,
  ]
  if (issues.length) lines.push('', '*Issues:*', ...issues.slice(0, 5).map((i) => `• ${i}`))
  lines.push('', `*Progress:* ${actions.length ? actions.join(', ') : 'nothing completed yet'}`)

  const lastAsk = (args.activity.inbound || [])[0]
  if (lastAsk?.body) lines.push('', `*Last said:* "${lastAsk.body.replace(/\s+/g, ' ').trim().slice(0, 140)}"`)

  return lines.join('\n')
}
