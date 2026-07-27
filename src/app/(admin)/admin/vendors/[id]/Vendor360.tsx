'use client'

import { useState, useCallback, useEffect } from 'react'
import { VendorTimeline } from '@/components/admin/inbox/VendorTimeline'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, MessageCircle, Mail, CreditCard, MapPin, Phone,
  FileText, Users, History, Eye, ChevronDown, ChevronUp, Loader2,
  StickyNote, Plus, Check, X, Trash2, AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'
import { AdminPage } from '@/components/admin/AdminPage'
import { KpiStrip } from '@/components/chrome/KpiStrip'
import { Kpi } from '@/components/chrome/Kpi'
import { DenseTable } from '@/components/chrome/DenseTable'
import { StatusPill } from '@/components/chrome/StatusPill'
import { ActionChipGrid } from '@/components/chrome/ActionChipGrid'
import { ActionChip } from '@/components/chrome/ActionChip'
import { RightDrawer } from '@/components/chrome/RightDrawer'
import type { PortalState, DocRecord, StaffMember } from '@/lib/portal-state'
import { TIER_META } from '@/lib/stalls'
import { computeVendorPricing } from '@/lib/payments/pricing'
import { REQUIRED_DOC_LABELS, type RequiredDocType } from './doc-types'
import { VendorStatusBanner } from '@/components/admin/vendor/VendorStatusBanner'
import { VendorPaymentsSection } from '@/components/admin/vendor/VendorPaymentsSection'
import { VendorContractSection } from '@/components/admin/vendor/VendorContractSection'
import { VendorDocsChecklist } from '@/components/admin/vendor/VendorDocsChecklist'
import { VendorActivityLog } from '@/components/admin/vendor/VendorActivityLog'
import { SpecialRequirementsView } from '@/components/admin/SpecialRequirementsView'

// Mirror of ELECTRICAL_OPTIONS in src/app/apply/page.tsx (minus 'none') and
// ELECTRICAL_PRICES in src/lib/payments/pricing.ts. Keep in sync.
const ELECTRICAL_OPTIONS: { value: string; label: string }[] = [
  { value: 'charger-lighting', label: 'Charger/Lighting' },
  { value: 'microwave', label: 'Microwave' },
  { value: 'urn', label: 'Urn' },
  { value: 'single-fryer', label: 'Single Fryer' },
  { value: 'double-fryer', label: 'Double Fryer' },
  { value: 'waffle-pancake-maker', label: 'Waffle/Pancake Maker' },
  { value: 'blender', label: 'Blender' },
  { value: 'coffee-machine', label: 'Coffee Machine' },
  { value: 'electric-stove', label: 'Electric Stove' },
  { value: 'small-display-fridge', label: 'Small Display Fridge' },
  { value: 'large-display-fridge-freezer', label: 'Large Display Fridge/Freezer' },
]

// Read the priced electrical map (slug -> qty) out of special_requirements,
// which may be a JSON string, an object, an array of slugs, or a human string.
function readElectrical(raw: unknown): Record<string, number> {
  let reqs: unknown = raw
  if (typeof raw === 'string') {
    try { reqs = JSON.parse(raw) } catch { return {} }
  }
  if (!reqs || typeof reqs !== 'object') return {}
  const elec = (reqs as { electrical_appliances?: unknown }).electrical_appliances
  const out: Record<string, number> = {}
  if (Array.isArray(elec)) {
    for (const k of elec) if (typeof k === 'string') out[k] = 1
  } else if (elec && typeof elec === 'object') {
    for (const [k, v] of Object.entries(elec as Record<string, unknown>)) {
      const q = Math.max(0, Math.floor(Number(v) || 0))
      if (q > 0) out[k] = q
    }
  }
  return out
}

interface CustomElectrical {
  label: string
  amount: number
  qty: number
}

// Read the off-list custom electrical charges out of special_requirements,
// which may be a JSON string or an object. Mirrors readElectrical above but
// pulls the operator-set special_requirements.electrical_custom array.
function readCustomElectrical(raw: unknown): CustomElectrical[] {
  let reqs: unknown = raw
  if (typeof raw === 'string') {
    try { reqs = JSON.parse(raw) } catch { return [] }
  }
  if (!reqs || typeof reqs !== 'object') return []
  const custom = (reqs as { electrical_custom?: unknown }).electrical_custom
  if (!Array.isArray(custom)) return []
  const out: CustomElectrical[] = []
  for (const row of custom) {
    if (!row || typeof row !== 'object') continue
    const r = row as { label?: unknown; amount?: unknown; qty?: unknown }
    const label = typeof r.label === 'string' ? r.label : ''
    const amount = Number(r.amount) || 0
    const qty = Math.max(1, Math.floor(Number(r.qty) || 1))
    out.push({ label, amount, qty })
  }
  return out
}

interface CommItem {
  id: string
  channel: 'whatsapp' | 'email'
  direction: 'in' | 'out'
  body: string
  at: string
  from: string
  to?: string
  subject?: string
  template?: string | null
}

interface AuditEvent {
  id: string
  event_type: string
  note: string | null
  created_at: string
  actor_email: string | null
}

interface Stats {
  days_since_approval: number | null
  document_count: number
  staff_count: number
  approved_count: number
}

interface InitialData {
  vendor: Record<string, unknown>
  stall: string | null
  portal: PortalState
  communications: CommItem[]
  events: AuditEvent[]
  stats: Stats
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—'
  try { return new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) } catch { return '—' }
}

function fmtShortDate(d: string | null | undefined): string {
  if (!d) return '—'
  try { return new Date(d).toLocaleString('en-GB', { dateStyle: 'medium' }) } catch { return '—' }
}

function fmtMoney(n?: number | null): string {
  if (!n) return '—'
  return `R ${n.toLocaleString('en-ZA')}`
}

function statusTone(status: string): 'success' | 'warn' | 'danger' | 'info' | 'neutral' {
  switch (status) {
    case 'approved': case 'paid': case 'confirmed': case 'active': return 'success'
    case 'pending': case 'invoiced': case 'deferred': return 'warn'
    case 'rejected': case 'cancelled': case 'failed': return 'danger'
    case 'reviewed': case 'submitted': return 'info'
    default: return 'neutral'
  }
}

export function Vendor360({ initialData }: { initialData: InitialData }) {
  const router = useRouter()
  const v = initialData.vendor
  const portal = initialData.portal
  const businessName = String(v.business_name || 'Vendor')
  const category = ((v.product_categories as string[])?.[0] || v.item_category || '') as string
  const phone = String(v.phone || '')
  const email = String(v.email || '')
  const contactName = String(v.contact_name || '')
  const status = String(v.status || 'pending')
  const stallCode = initialData.stall
  const stats = initialData.stats

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerView, setDrawerView] = useState<'contact' | 'doc' | 'paid'>('contact')
  const [previewDoc, setPreviewDoc] = useState<DocRecord | null>(null)
  const [markPaidBusy, setMarkPaidBusy] = useState(false)
  const [markPaidMethod, setMarkPaidMethod] = useState<'' | 'eft' | 'cash' | 'manual_card' | 'waived'>('')
  const [markPaidAmount, setMarkPaidAmount] = useState('')
  const [markPaidRef, setMarkPaidRef] = useState('')
  const [markPaidNote, setMarkPaidNote] = useState('')
  const [markPaidErr, setMarkPaidErr] = useState<string | null>(null)

  // --- EFT payment / refund proof upload state ---
  const [proofFile, setProofFile] = useState<File | null>(null)
  const [proofKind, setProofKind] = useState<'receipt' | 'refund'>('receipt')
  const [proofNote, setProofNote] = useState('')
  const [proofBusy, setProofBusy] = useState(false)
  const [proofErr, setProofErr] = useState<string | null>(null)
  const [proofOk, setProofOk] = useState(false)
  // Bump on each successful upload to force the file input to remount + clear.
  const [proofInputKey, setProofInputKey] = useState(0)

  // --- Edit contact / amend application form state ---
  const [editBusiness, setEditBusiness] = useState('')
  const [editContact, setEditContact] = useState('')
  const [editEmail, setEditEmail] = useState('')
  const [editPhone, setEditPhone] = useState('')
  const [editCategory, setEditCategory] = useState('')
  const [editTier, setEditTier] = useState('')
  const [editElectrical, setEditElectrical] = useState<Record<string, number>>({})
  const [editCustomElectrical, setEditCustomElectrical] = useState<CustomElectrical[]>([])
  const [editBusy, setEditBusy] = useState(false)
  const [editErr, setEditErr] = useState<string | null>(null)
  const [editOk, setEditOk] = useState(false)

  // --- Withdraw (soft-delete) state ---
  const [withdrawOpen, setWithdrawOpen] = useState(false)
  const [withdrawReason, setWithdrawReason] = useState('')
  const [withdrawBusy, setWithdrawBusy] = useState(false)
  // Only a vendor carrying the withdrawn marker AND sitting at status='rejected'
  // is "withdrawn". A genuine application rejection (no marker) still reads as
  // 'rejected'; a re-approved vendor (status flips back) sheds the label.
  const isWithdrawn = !!portal.withdrawn && status === 'rejected'


  function openContactDrawer() {
    setEditBusiness(businessName)
    setEditContact(contactName)
    setEditEmail(email)
    setEditPhone(phone)
    setEditCategory(category)
    setEditTier(v.preferred_booth_tier ? String(v.preferred_booth_tier) : '')
    setEditElectrical(readElectrical(v.special_requirements))
    setEditCustomElectrical(readCustomElectrical(v.special_requirements))
    setEditErr(null)
    setEditOk(false)
    setDrawerView('contact')
    setDrawerOpen(true)
  }

  function setApplianceQty(slug: string, qty: number) {
    setEditElectrical((prev) => {
      const next = { ...prev }
      if (qty <= 0) delete next[slug]
      else next[slug] = qty
      return next
    })
  }

  async function handleSaveContact() {
    setEditBusy(true)
    setEditErr(null)
    setEditOk(false)
    try {
      const cats = editCategory.trim()
        ? [editCategory.trim(), ...((v.product_categories as string[]) || []).slice(1)]
        : ((v.product_categories as string[]) || [])
      // Keep any row with an amount > 0 (the amount is what charges). Default a
      // blank label so typing just an amount still adds the charge. Drop only
      // truly empty rows (no amount).
      const customCharges = editCustomElectrical
        .filter((c) => (Number(c.amount) || 0) > 0)
        .map((c) => ({
          label: c.label.trim() || 'Additional charge',
          amount: Number(c.amount) || 0,
          qty: Math.max(1, Math.floor(Number(c.qty) || 1)),
        }))
      const r = await fetch(`/api/admin/vendors/${v.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_name: editBusiness,
          contact_name: editContact,
          email: editEmail,
          phone: editPhone,
          product_categories: cats,
          preferred_booth_tier: editTier,
          electrical_appliances: editElectrical,
          electrical_custom: customCharges,
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setEditErr(j.error || 'Failed to save'); return }
      setEditOk(true)
      setDrawerOpen(false)
      router.refresh()
    } catch (e) {
      setEditErr((e as Error).message)
    } finally {
      setEditBusy(false)
    }
  }

  function openDocPreview(doc: DocRecord) {
    setPreviewDoc(doc)
    setDrawerView('doc')
    setDrawerOpen(true)
  }

  // Approve / reject a single uploaded document. Hits the doc-action route,
  // which mutates portal.docs[].status, fires notifyVendor(document_approved/
  // rejected), and stamps ⟦DOCS:complete⟧ once every required doc is approved.
  const [docBusy, setDocBusy] = useState<string | null>(null)
  async function handleDocAction(doc: DocRecord, action: 'approve' | 'reject') {
    const key = `${doc.type}:${action}`
    let note: string | undefined
    if (action === 'reject') {
      const reason = window.prompt(`Reason for rejecting "${doc.name}"? (sent to the vendor)`)
      if (reason === null) return // operator cancelled
      note = reason.trim() || undefined
    }
    setDocBusy(key)
    try {
      const r = await fetch(`/api/admin/vendors/${v.id}/doc-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: doc.type, action, note }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || `Failed (${r.status})`)
      const label = REQUIRED_DOC_LABELS[doc.type] || doc.type
      if (action === 'approve') {
        toast.success(
          j.all_required_approved
            ? `${label} approved. All required docs complete, vendor notified.`
            : `${label} approved. Vendor notified.`
        )
      } else {
        toast.success(`${label} rejected. Vendor notified.`)
      }
      setDrawerOpen(false)
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message || 'Document action failed')
    } finally {
      setDocBusy(null)
    }
  }

  function openMarkPaid() {
    setDrawerView('paid')
    // Vendors pay the OUTSTANDING balance (total owed minus what they've already
    // paid), not the cumulative already-paid figure. Pre-fill the field with the
    // amount due NOW so the operator records the right payment.
    const total = computeVendorPricing({
      preferred_booth_tier: v.preferred_booth_tier as string,
      special_requirements: v.special_requirements,
    }).total
    const paidSoFar = portal.payment?.amount || 0
    const outstanding = Math.max(0, total - paidSoFar)
    setMarkPaidAmount(outstanding > 0 ? String(outstanding) : '')
    setMarkPaidMethod('')
    setMarkPaidRef('')
    setMarkPaidNote('')
    setMarkPaidErr(null)
    setDrawerOpen(true)
  }

  async function handleMarkPaid() {
    if (!markPaidMethod) { setMarkPaidErr('Pick how they paid.'); return }
    setMarkPaidBusy(true)
    setMarkPaidErr(null)
    try {
      const r = await fetch(`/api/admin/vendors/${v.id}/mark-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: markPaidMethod,
          amount: markPaidAmount ? Number(markPaidAmount) : undefined,
          reference: markPaidRef || undefined,
          note: markPaidNote || undefined,
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setMarkPaidErr(j.error || 'Failed'); return }
      setDrawerOpen(false)
    } catch (e) {
      setMarkPaidErr((e as Error).message)
    } finally {
      setMarkPaidBusy(false)
    }
  }

  // Upload an EFT payment receipt or a refund proof. POSTs multipart form-data
  // to /api/admin/vendors/[id]/payment-proof, which stores the file in the
  // private vendor-docs bucket and appends to state.payment.proofs. The vendor
  // then sees it in their portal payments page via a signed URL (Law 2).
  async function handleUploadProof() {
    if (!proofFile) { setProofErr('Choose a file first'); return }
    setProofBusy(true)
    setProofErr(null)
    setProofOk(false)
    try {
      const fd = new FormData()
      fd.append('file', proofFile)
      fd.append('kind', proofKind)
      if (proofNote.trim()) fd.append('note', proofNote.trim())
      const r = await fetch(`/api/admin/vendors/${v.id}/payment-proof`, {
        method: 'POST',
        body: fd,
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setProofErr(j.error || `Failed (${r.status})`); return }
      setProofOk(true)
      setProofFile(null)
      setProofNote('')
      setProofInputKey((k) => k + 1)
      router.refresh()
    } catch (e) {
      setProofErr((e as Error).message)
    } finally {
      setProofBusy(false)
    }
  }

  // Withdraw (soft-delete) a vendor that no longer wants to trade. Frees their
  // stall and removes them from the approved-vendor lists. Reversible by
  // re-approving under Applications. Hits DELETE /api/admin/vendors/[id].
  async function handleWithdraw() {
    setWithdrawBusy(true)
    try {
      const r = await fetch(`/api/admin/vendors/${v.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: withdrawReason.trim() || undefined }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { toast.error(j.error || `Failed to withdraw (${r.status})`); return }
      const freed = Array.isArray(j.freed_stalls) && j.freed_stalls.length
        ? ` Stall ${j.freed_stalls.join(', ')} freed.`
        : ''
      toast.success(`${businessName} withdrawn.${freed}`)
      setWithdrawOpen(false)
      router.push('/admin/vendors')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setWithdrawBusy(false)
    }
  }

  // In-app targets (never leave the admin site). WhatsApp/Email open the master
  // inbox on THIS vendor's thread via a deep-link param; the old wa.me / mailto
  // links flung the operator out to an external app.
  const waContact = phone
    ? `+${phone.replace(/[^0-9]/g, '').replace(/^0/, '27')}`
    : null

  return (
    <AdminPage
      caption="Vendor Profile"
      title={businessName}
      subtitle={category || undefined}
    >
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Link
          href="/admin/vendors"
          className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-700 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back to vendors
        </Link>
        <span className="text-neutral-300">|</span>
        <span className="font-serif text-xl text-neutral-800">{businessName}</span>
        {category && (
          <span className="inline-flex items-center h-5 px-2.5 rounded-full text-xs font-medium bg-neutral-100 text-neutral-700">
            {category}
          </span>
        )}
        {stallCode && (
          <span className="font-mono text-xs text-neutral-500 bg-neutral-50 px-2 py-0.5 rounded border border-neutral-200">
            {stallCode}
          </span>
        )}
        <StatusPill tone={statusTone(status)} label={isWithdrawn ? 'withdrawn' : status} />
        {isWithdrawn ? (
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-neutral-500">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
            Withdrawn{portal.withdrawn?.at ? ` · ${fmtShortDate(portal.withdrawn.at)}` : ''}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => { setWithdrawReason(''); setWithdrawOpen(true) }}
            className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium text-neutral-500 hover:text-rose-600 border border-neutral-200 hover:border-rose-300 rounded-md px-2.5 py-1.5 transition-colors"
            title="Remove this vendor if they no longer want to trade"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Withdraw vendor
          </button>
        )}
      </div>

      <ActionChipGrid>
        <ActionChip
          icon={<MessageCircle className="w-4 h-4" />}
          label="Send WhatsApp"
          tone="mint"
          onClick={waContact ? () => router.push(`/admin/inbox/whatsapp?contact=${encodeURIComponent(waContact)}`) : undefined}
        />
        <ActionChip
          icon={<Mail className="w-4 h-4" />}
          label="Send Email"
          tone="sky"
          onClick={email ? () => router.push(`/admin/inbox/support?contact=${encodeURIComponent(email)}`) : undefined}
        />
        <ActionChip
          icon={<CreditCard className="w-4 h-4" />}
          label="Mark Paid"
          tone="butter"
          onClick={openMarkPaid}
        />
        <ActionChip
          icon={<MapPin className="w-4 h-4" />}
          label={stallCode ? 'View Stand' : 'Allocate Stall'}
          tone="lavender"
          onClick={() => router.push(stallCode ? `/admin/allocation?focus=${encodeURIComponent(stallCode)}` : '/admin/allocation')}
        />
      </ActionChipGrid>

      <div className="mt-4">
        <VendorStatusBanner vendor={v} portal={portal} stallCode={stallCode} />
      </div>

      <KpiStrip>
        <Kpi
          label="Payment"
          value={
            <span className="flex items-center gap-2">
              {fmtMoney(portal.payment?.amount)}
              <StatusPill
                tone={statusTone(portal.payment?.status || 'none')}
                label={portal.payment?.status || 'none'}
              />
            </span>
          }
          hint={portal.payment?.reference ? `Ref: ${portal.payment.reference}` : undefined}
        />
        <Kpi
          label="Documents"
          value={`${stats.approved_count}/${stats.document_count}`}
          hint={stats.document_count === 0 ? 'None uploaded' : `${stats.approved_count} approved`}
        />
        <Kpi
          label="Staff"
          value={stats.staff_count}
          hint={stats.staff_count === 0 ? 'None registered' : undefined}
        />
        <Kpi
          label="Days since approval"
          value={stats.days_since_approval !== null ? stats.days_since_approval : '—'}
          hint={stats.days_since_approval !== null ? 'Since approval' : 'Not yet approved'}
        />
      </KpiStrip>

      <Section title="Contact Info" icon={<Phone className="w-4 h-4" />}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <LabeledField label="Contact person" value={contactName} />
          <LabeledField label="Email" value={email} mono />
          <LabeledField label="Phone" value={phone} mono />
          <LabeledField label="Contact ID" value={String(v.id)} mono />
        </div>
        <button
          onClick={openContactDrawer}
          className="mt-3 text-xs text-blue-700 hover:underline"
        >
          Edit contact info
        </button>
      </Section>

      <Section title="Application Details" icon={<FileText className="w-4 h-4" />}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <LabeledField
            label="Stall tier"
            value={v.preferred_booth_tier ? String(v.preferred_booth_tier).replace(/-/g, ' ') : '—'}
          />
          <LabeledField label="Stall code" value={stallCode || '—'} mono />
          <LabeledField label="Sector" value={category || '—'} />
          <LabeledField label="Items / menu" value={v.items_description ? String(v.items_description).slice(0, 200) : '—'} />
          <div className="sm:col-span-2">
            <p className="text-[11px] uppercase tracking-wide text-neutral-400 mb-1.5">Special requirements</p>
            <SpecialRequirementsView raw={v.special_requirements as string | Record<string, unknown> | null} />
          </div>
          <LabeledField label="Applied" value={v.created_at ? fmtDate(v.created_at as string) : '—'} />
        </div>
      </Section>

      <VendorPaymentsSection applicationId={String(v.id)} vendor={v} portal={portal} />

      <VendorContractSection applicationId={String(v.id)} vendor={v} />

      <Section title="Quick Notes" icon={<StickyNote className="w-4 h-4" />}>
        <QuickNotesSection applicationId={String(v.id)} />
      </Section>

      {/* One vendor, every channel, in time order. This is where the split
          channels meet again (Taona: "how do we find a way that allows us to see
          messages from both channels when we need to"). Replaces a flat,
          unpaginated log that read from a separate server payload. */}
      <Section title="Full History" icon={<Mail className="w-4 h-4" />}>
        <VendorTimeline applicationId={String(v.id)} />
      </Section>

      <VendorDocsChecklist applicationId={String(v.id)} docs={portal.docs || []} />

      <Section title="Documents" icon={<FileText className="w-4 h-4" />}>
        <DenseTable<DocRecord>
          columns={[
            { key: 'type', header: 'Type', render: (doc) => REQUIRED_DOC_LABELS[doc.type as RequiredDocType] || doc.type },
            { key: 'name', header: 'File' },
            { key: 'uploaded_at', header: 'Uploaded', render: (doc) => fmtShortDate(doc.uploaded_at) },
            {
              key: 'status', header: 'Status', render: (doc) => (
                <StatusPill
                  tone={doc.status === 'approved' ? 'success' : doc.status === 'rejected' ? 'danger' : 'warn'}
                  label={doc.status}
                />
              ),
            },
            {
              key: 'actions', header: '', width: '210px', render: (doc) => (
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={(e) => { e.stopPropagation(); openDocPreview(doc) }}
                    className="text-xs text-blue-700 hover:underline inline-flex items-center gap-1"
                  >
                    <Eye className="w-3 h-3" /> View
                  </button>
                  {doc.status !== 'approved' && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDocAction(doc, 'approve') }}
                      disabled={docBusy !== null}
                      className="text-xs font-semibold text-green-700 hover:text-green-800 inline-flex items-center gap-1 disabled:opacity-50"
                    >
                      {docBusy === `${doc.type}:approve`
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : <Check className="w-3 h-3" />} Approve
                    </button>
                  )}
                  {doc.status !== 'rejected' && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDocAction(doc, 'reject') }}
                      disabled={docBusy !== null}
                      className="text-xs font-semibold text-[#cd2653] hover:text-[#bf3026] inline-flex items-center gap-1 disabled:opacity-50"
                    >
                      {docBusy === `${doc.type}:reject`
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : <X className="w-3 h-3" />} Reject
                    </button>
                  )}
                </div>
              ),
            },
          ]}
          rows={portal.docs || []}
          emptyState={{ label: 'No documents uploaded' }}
        />
      </Section>

      <Section title="Staff" icon={<Users className="w-4 h-4" />}>
        <DenseTable<StaffMember>
          columns={[
            { key: 'name', header: 'Name' },
            { key: 'phone', header: 'Phone', render: (s) => s.phone || '—' },
            {
              key: 'role', header: 'Role', render: (s) => s.role || 'staff',
            },
            {
              key: 'badge', header: 'Badge status', render: (s) => {
                if (s.revoked_at) return <StatusPill tone="danger" label="Revoked" />
                if (s.checked_in_at) return <StatusPill tone="success" label={`Checked in ${fmtShortDate(s.checked_in_at)}`} />
                return <StatusPill tone="warn" label="Not yet" />
              },
            },
            {
              key: 'wc_order_id', header: 'Order', render: (s) => s.wc_order_id
                ? <span className="font-mono text-xs">#{s.wc_order_number || s.wc_order_id}</span>
                : '—',
            },
          ]}
          rows={portal.staff || []}
          emptyState={{ label: 'No staff registered' }}
        />
      </Section>

      <Section title="Activity Timeline" icon={<History className="w-4 h-4" />}>
        {initialData.events.length === 0 ? (
          <p className="text-sm text-neutral-500">No events recorded.</p>
        ) : (
          <div className="relative pl-6 space-y-0">
            <div className="absolute left-2.5 top-2 bottom-2 w-px bg-neutral-200" />
            {initialData.events.map((e) => (
              <div key={e.id} className="relative pb-4 pl-4">
                <div className="absolute left-[-14px] top-1.5 w-2.5 h-2.5 rounded-full border-2 border-neutral-300 bg-white" />
                <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3">
                  <span className="text-xs text-neutral-400 tabular-nums whitespace-nowrap">
                    {fmtDate(e.created_at)}
                  </span>
                  <span className="text-xs font-medium text-neutral-700 capitalize">
                    {e.event_type.replace(/_/g, ' ')}
                  </span>
                  <span className="text-xs text-neutral-600">
                    {e.note || ''}
                    {e.actor_email ? <span className="text-neutral-400"> · {e.actor_email}</span> : null}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Activity Log" icon={<History className="w-4 h-4" />}>
        <VendorActivityLog events={initialData.events} />
      </Section>

      <RightDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={drawerView === 'contact' ? 'Edit Contact Info' : drawerView === 'paid' ? 'Mark as Paid' : previewDoc ? REQUIRED_DOC_LABELS[previewDoc.type as RequiredDocType] || previewDoc.type : 'Document Preview'}
      >
        {drawerView === 'contact' && (
          <div className="space-y-4">
            <p className="text-xs text-neutral-500">
              Amend this vendor&apos;s details on their behalf. Saves a vendor_amended audit event.
            </p>
            <div>
              <label className="text-xs font-medium text-neutral-600 block mb-1">Business name</label>
              <input
                type="text"
                value={editBusiness}
                onChange={(e) => setEditBusiness(e.target.value)}
                className="w-full border border-neutral-200 rounded-md px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-neutral-600 block mb-1">Contact person</label>
              <input
                type="text"
                value={editContact}
                onChange={(e) => setEditContact(e.target.value)}
                className="w-full border border-neutral-200 rounded-md px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-neutral-600 block mb-1">Email</label>
              <input
                type="email"
                value={editEmail}
                onChange={(e) => setEditEmail(e.target.value)}
                className="w-full border border-neutral-200 rounded-md px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-neutral-600 block mb-1">Phone</label>
              <input
                type="tel"
                value={editPhone}
                onChange={(e) => setEditPhone(e.target.value)}
                className="w-full border border-neutral-200 rounded-md px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-neutral-600 block mb-1">Category</label>
              <input
                type="text"
                value={editCategory}
                onChange={(e) => setEditCategory(e.target.value)}
                className="w-full border border-neutral-200 rounded-md px-3 py-2 text-sm"
                placeholder="e.g. Food, Fashion"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-neutral-600 block mb-1">Stall size / tier</label>
              <select
                value={editTier}
                onChange={(e) => setEditTier(e.target.value)}
                className="w-full border border-neutral-200 rounded-md px-3 py-2 text-sm bg-white"
              >
                <option value="">Not specified</option>
                {Object.entries(TIER_META).map(([slug, meta]) => (
                  <option key={slug} value={slug}>
                    {meta.label} (R{meta.price.toLocaleString('en-ZA')})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-neutral-600 block mb-2">Electrical appliances</label>
              <div className="space-y-1.5">
                {ELECTRICAL_OPTIONS.map((opt) => {
                  const qty = editElectrical[opt.value] || 0
                  return (
                    <div key={opt.value} className="flex items-center justify-between gap-2">
                      <span className={`text-sm ${qty > 0 ? 'text-neutral-900 font-medium' : 'text-neutral-600'}`}>
                        {opt.label}
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => setApplianceQty(opt.value, qty - 1)}
                          disabled={qty <= 0}
                          className="w-6 h-6 rounded border border-neutral-200 text-neutral-600 disabled:opacity-40 hover:bg-neutral-50"
                        >
                          −
                        </button>
                        <span className="w-6 text-center text-sm tabular-nums">{qty}</span>
                        <button
                          type="button"
                          onClick={() => setApplianceQty(opt.value, qty + 1)}
                          className="w-6 h-6 rounded border border-neutral-200 text-neutral-600 hover:bg-neutral-50"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-neutral-600 block mb-1">Additional charges</label>
              <p className="text-xs text-neutral-500 mb-2">
                Add a charge to this vendor (off-list appliances, extra space, or any additional payment request). Each adds to their total and what they pay.
              </p>
              <div className="space-y-2">
                {editCustomElectrical.map((row, i) => {
                  const subtotal = (Number(row.amount) || 0) * Math.max(1, Math.floor(Number(row.qty) || 1))
                  return (
                    <div key={i} className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={row.label}
                        onChange={(e) => setEditCustomElectrical((prev) =>
                          prev.map((r, idx) => idx === i ? { ...r, label: e.target.value } : r)
                        )}
                        placeholder="e.g. 2x Slurpee machine"
                        aria-label="Charge label"
                        className="flex-1 min-w-0 border border-neutral-200 rounded-md px-2 py-1.5 text-sm"
                      />
                      <input
                        type="number"
                        value={row.amount}
                        onChange={(e) => setEditCustomElectrical((prev) =>
                          prev.map((r, idx) => idx === i ? { ...r, amount: Number(e.target.value) } : r)
                        )}
                        placeholder="R / unit"
                        aria-label="Amount in Rand per unit"
                        className="w-20 shrink-0 border border-neutral-200 rounded-md px-2 py-1.5 text-sm tabular-nums"
                      />
                      <input
                        type="number"
                        min={1}
                        value={row.qty}
                        onChange={(e) => setEditCustomElectrical((prev) =>
                          prev.map((r, idx) => idx === i ? { ...r, qty: Math.max(1, Math.floor(Number(e.target.value) || 1)) } : r)
                        )}
                        aria-label="Quantity"
                        className="w-14 shrink-0 border border-neutral-200 rounded-md px-2 py-1.5 text-sm tabular-nums"
                      />
                      <span className="w-20 shrink-0 text-right text-xs text-neutral-500 tabular-nums">
                        {fmtMoney(subtotal)}
                      </span>
                      <button
                        type="button"
                        onClick={() => setEditCustomElectrical((prev) => prev.filter((_, idx) => idx !== i))}
                        aria-label="Remove charge"
                        className="w-6 h-6 shrink-0 rounded border border-neutral-200 text-neutral-500 hover:bg-neutral-50 inline-flex items-center justify-center"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  )
                })}
              </div>
              <div className="flex items-center justify-between mt-2">
                <button
                  type="button"
                  onClick={() => setEditCustomElectrical((prev) => [...prev, { label: '', amount: 0, qty: 1 }])}
                  className="text-xs text-blue-700 hover:underline inline-flex items-center gap-1"
                >
                  <Plus className="w-3 h-3" /> Add charge
                </button>
                {editCustomElectrical.length > 0 && (
                  <span className="text-xs text-neutral-600 tabular-nums">
                    Custom total: {fmtMoney(
                      editCustomElectrical.reduce(
                        (sum, r) => sum + (Number(r.amount) || 0) * Math.max(1, Math.floor(Number(r.qty) || 1)),
                        0
                      )
                    )}
                  </span>
                )}
              </div>
            </div>
            {editErr && <p className="text-xs text-red-600">{editErr}</p>}
            {editOk && <p className="text-xs text-emerald-600">Saved.</p>}
            <button
              onClick={handleSaveContact}
              disabled={editBusy}
              className="w-full bg-[#cd2653] hover:bg-[#b01f45] text-white text-sm font-medium py-2 px-4 rounded-md disabled:opacity-60 inline-flex items-center justify-center gap-2"
            >
              {editBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Save Changes
            </button>
          </div>
        )}

        {drawerView === 'paid' && (
          <div className="space-y-4">
            <p className="text-xs text-neutral-500">Logs a payment_manual audit event and flips the portal marker.</p>
            <div>
              <label className="text-xs font-medium text-neutral-600 block mb-1">How did they pay? *</label>
              <select
                value={markPaidMethod}
                onChange={(e) => setMarkPaidMethod(e.target.value as typeof markPaidMethod)}
                className="w-full border border-neutral-200 rounded-md px-3 py-2 text-sm bg-white"
              >
                <option value="">Select a method…</option>
                <option value="eft">EFT (bank transfer)</option>
                <option value="cash">Cash</option>
                <option value="manual_card">Card, in person (not Yoco)</option>
                <option value="waived">Waived (no payment, fee excused)</option>
              </select>
              <p className="text-xs text-neutral-500 mt-1">Shown on their invoice, so pick what actually happened.</p>
            </div>
            <div>
              <label className="text-xs font-medium text-neutral-600 block mb-1">Amount (R)</label>
              <p className="text-xs text-neutral-500 mb-1">Outstanding balance (what they still owe)</p>
              <input
                type="number"
                value={markPaidAmount}
                onChange={(e) => setMarkPaidAmount(e.target.value)}
                className="w-full border border-neutral-200 rounded-md px-3 py-2 text-sm"
                placeholder="e.g. 6500"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-neutral-600 block mb-1">Reference</label>
              <input
                type="text"
                value={markPaidRef}
                onChange={(e) => setMarkPaidRef(e.target.value)}
                className="w-full border border-neutral-200 rounded-md px-3 py-2 text-sm"
                placeholder="EFT ref / invoice #"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-neutral-600 block mb-1">Note</label>
              <input
                type="text"
                value={markPaidNote}
                onChange={(e) => setMarkPaidNote(e.target.value)}
                className="w-full border border-neutral-200 rounded-md px-3 py-2 text-sm"
                placeholder="Optional note"
              />
            </div>
            {markPaidErr && <p className="text-xs text-red-600">{markPaidErr}</p>}
            <button
              onClick={handleMarkPaid}
              disabled={markPaidBusy || !markPaidMethod}
              className="w-full bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium py-2 px-4 rounded-md disabled:opacity-60 inline-flex items-center justify-center gap-2"
            >
              {markPaidBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
              Confirm Paid
            </button>

            {/* EFT payment / refund proof upload. The file lands in the private
                vendor-docs bucket; the vendor sees it on their portal payments
                page via a short-lived signed URL (Law 2). */}
            <div className="pt-4 mt-2 border-t border-neutral-200 space-y-4">
              <div>
                <p className="text-sm font-medium text-neutral-700">EFT payment / refund proof</p>
                <p className="text-xs text-neutral-500 mt-1">
                  Upload a bank receipt for an extra EFT payment, or a refund proof. The vendor sees it in their portal.
                </p>
              </div>
              <div>
                <label className="text-xs font-medium text-neutral-600 block mb-1">Proof type</label>
                <select
                  value={proofKind}
                  onChange={(e) => setProofKind(e.target.value as 'receipt' | 'refund')}
                  aria-label="Proof type"
                  className="w-full border border-neutral-200 rounded-md px-3 py-2 text-sm bg-white"
                >
                  <option value="receipt">Payment receipt</option>
                  <option value="refund">Refund proof</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-neutral-600 block mb-1">File</label>
                <input
                  key={proofInputKey}
                  type="file"
                  onChange={(e) => setProofFile(e.target.files?.[0] || null)}
                  aria-label="Proof file"
                  className="w-full border border-neutral-200 rounded-md px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-neutral-100 file:px-2 file:py-1 file:text-xs file:font-medium file:text-neutral-700"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-neutral-600 block mb-1">Note</label>
                <input
                  type="text"
                  value={proofNote}
                  onChange={(e) => setProofNote(e.target.value)}
                  aria-label="Proof note"
                  className="w-full border border-neutral-200 rounded-md px-3 py-2 text-sm"
                  placeholder="Optional note, e.g. EFT for extra electrical"
                />
              </div>
              {proofErr && <p className="text-xs text-red-600">{proofErr}</p>}
              {proofOk && <p className="text-xs text-emerald-600">Proof uploaded. Vendor can now see it.</p>}
              <button
                onClick={handleUploadProof}
                disabled={proofBusy || !proofFile}
                className="w-full bg-[#cd2653] hover:bg-[#b01f45] text-white text-sm font-medium py-2 px-4 rounded-md disabled:opacity-60 inline-flex items-center justify-center gap-2"
              >
                {proofBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                Upload Proof
              </button>
            </div>
          </div>
        )}

        {drawerView === 'doc' && previewDoc && (
          <div className="space-y-4">
            <div>
              <LabeledField label="File" value={previewDoc.name} />
              <LabeledField label="Type" value={REQUIRED_DOC_LABELS[previewDoc.type as RequiredDocType] || previewDoc.type} />
              <LabeledField label="Uploaded" value={fmtDate(previewDoc.uploaded_at)} />
              <LabeledField
                label="Status"
                value={<StatusPill tone={previewDoc.status === 'approved' ? 'success' : previewDoc.status === 'rejected' ? 'danger' : 'warn'} label={previewDoc.status} />}
              />
            </div>
            <div className="border border-neutral-200 rounded-lg overflow-hidden bg-neutral-50">
              {previewDoc.path ? (
                <iframe
                  src={`/api/admin/vendor-doc?path=${encodeURIComponent(previewDoc.path)}`}
                  title={previewDoc.name}
                  className="w-full h-[400px] bg-white"
                />
              ) : (
                <div className="flex items-center justify-center h-[200px] text-neutral-400 text-sm">
                  No file path
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={() => handleDocAction(previewDoc, 'approve')}
                disabled={docBusy !== null || previewDoc.status === 'approved'}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
              >
                {docBusy === `${previewDoc.type}:approve`
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <Check className="w-4 h-4" />}
                {previewDoc.status === 'approved' ? 'Approved' : 'Approve'}
              </button>
              <button
                onClick={() => handleDocAction(previewDoc, 'reject')}
                disabled={docBusy !== null || previewDoc.status === 'rejected'}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-[#cd2653] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#bf3026] disabled:opacity-50"
              >
                {docBusy === `${previewDoc.type}:reject`
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <X className="w-4 h-4" />}
                {previewDoc.status === 'rejected' ? 'Rejected' : 'Reject'}
              </button>
            </div>
          </div>
        )}
      </RightDrawer>

      {withdrawOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !withdrawBusy && setWithdrawOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white shadow-xl border border-neutral-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 border-b border-neutral-100 flex items-start gap-3">
              <div className="mt-0.5 flex-shrink-0 w-9 h-9 rounded-full bg-rose-50 flex items-center justify-center">
                <Trash2 className="w-4 h-4 text-rose-600" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-neutral-900">Withdraw {businessName}?</h3>
                <p className="text-xs text-neutral-500 mt-1">
                  This removes them from the vendors list and allocations, and frees
                  any stall they hold{stallCode ? ` (${stallCode})` : ''}. Their record
                  and history are kept, so you can re-approve them later under Applications.
                </p>
              </div>
            </div>
            <div className="p-5">
              <label className="block text-xs font-medium text-neutral-600 mb-1">
                Reason <span className="text-neutral-400 font-normal">(optional)</span>
              </label>
              <textarea
                value={withdrawReason}
                onChange={(e) => setWithdrawReason(e.target.value)}
                rows={2}
                placeholder="e.g. No longer trading"
                className="w-full px-2.5 py-2 text-sm border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-rose-400"
              />
            </div>
            <div className="px-5 pb-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setWithdrawOpen(false)}
                disabled={withdrawBusy}
                className="px-3 py-1.5 text-sm font-medium text-neutral-600 hover:text-neutral-900 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleWithdraw}
                disabled={withdrawBusy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-60"
              >
                {withdrawBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                Withdraw vendor
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminPage>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Quick Notes
// ─────────────────────────────────────────────────────────────────────────────

interface QuickNoteItem {
  id: string
  text: string
  created_at: string
  author: string | null
}

function QuickNotesSection({ applicationId }: { applicationId: string }) {
  const [notes, setNotes] = useState<QuickNoteItem[]>([])
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadNotes = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/vendors/${applicationId}/notes`)
      if (!res.ok) return
      const d = await res.json()
      setNotes((d.notes as QuickNoteItem[]) ?? [])
    } catch (e) {
      setError(String((e as Error)?.message || e))
    } finally {
      setLoading(false)
    }
  }, [applicationId])

  useEffect(() => {
    loadNotes()
  }, [loadNotes])

  async function saveNote() {
    const trimmed = text.trim()
    if (!trimmed) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/vendors/${applicationId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError(j.error || 'Failed to save note')
        return
      }
      const d = await res.json()
      setNotes((prev) => [d.note as QuickNoteItem, ...prev])
      setText('')
    } catch (e) {
      setError(String((e as Error)?.message || e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a quick note..."
          rows={3}
          className="flex-1 border border-neutral-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#cd2653]"
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={saveNote}
          disabled={saving || !text.trim()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-[#cd2653] text-white hover:bg-[#b01f45] disabled:opacity-60"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          Add Note
        </button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>

      {loading ? (
        <p className="text-sm text-neutral-500 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading notes...
        </p>
      ) : notes.length === 0 ? (
        <p className="text-sm text-neutral-500">No notes yet. Add one above.</p>
      ) : (
        <ul className="space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-lg border border-neutral-100 bg-neutral-50 p-3">
              <p className="text-sm text-neutral-900 whitespace-pre-wrap break-words">{n.text}</p>
              <p className="text-[11px] text-neutral-400 mt-1.5">
                {n.author && <span>{n.author} · </span>}
                {fmtDate(n.created_at)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="bg-[var(--bg-surface)] rounded-lg border border-[var(--border)] shadow-sm p-5">
      <h3 className="font-serif text-lg text-[var(--text-primary)] mb-4 flex items-center gap-2">
        {icon} {title}
      </h3>
      {children}
    </section>
  )
}

function LabeledField({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-0.5">{label}</p>
      <p className={`text-sm text-neutral-800 ${mono ? 'font-mono text-xs' : ''}`}>
        {value ?? '—'}
      </p>
    </div>
  )
}
