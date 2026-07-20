// Vendor-facing panel listing the documents the festival generated FOR the
// vendor (invoice, signed contract, staff badge PDFs) with download links.
//
// Pure render. No state. All download routes are auth-gated server-side; this
// component only knows whether each artefact exists so it can disable links
// that point nowhere.

import { FileText, FileSignature, IdCard, Download, Loader2 } from 'lucide-react'
import SafeDownloadLink from './SafeDownloadLink'

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'file'

export interface StaffBadgeRef {
  name: string
  role: string
  wc_order_id?: number
  fooevents_ticket_id?: string
}

export interface GeneratedDocsProps {
  // Invoice is always available once the vendor exists; we render based on
  // payment status so a paid vendor's "PAID" stamp shows.
  invoiceStatus: 'none' | 'deferred' | 'pending' | 'paid' | 'waived'
  invoiceRef: string
  // Contract is downloadable only once contract_signed_at is stamped.
  contractSigned: boolean
  // Staff badges. Each row links out to the FooEvents PDF via our auth-gated
  // resolver route; if no wc_order_id yet, the row is shown disabled.
  staffBadges: StaffBadgeRef[]
}

export default function GeneratedDocsPanel({
  invoiceStatus,
  invoiceRef,
  contractSigned,
  staffBadges,
}: GeneratedDocsProps) {
  const invoicePaid = invoiceStatus === 'paid' || invoiceStatus === 'waived'

  return (
    <div className="space-y-4">
      <Row
        Icon={FileText}
        title="Tax invoice"
        subtitle={
          invoicePaid
            ? `Reference ${invoiceRef}. Marked paid.`
            : `Reference ${invoiceRef}. Outstanding.`
        }
        href="/api/exhibitor/portal/invoice/pdf"
        cta="Download PDF"
        tone={invoicePaid ? 'good' : 'warn'}
      />

      <Row
        Icon={FileSignature}
        title="Signed vendor contract"
        subtitle={
          contractSigned
            ? 'Signed and on file. Click to download a copy.'
            : 'Not signed yet. Sign on the Contract tab to unlock this download.'
        }
        href={contractSigned ? '/api/exhibitor/portal/contract/pdf' : '/exhibitor/portal/contract'}
        cta={contractSigned ? 'Download PDF' : 'Sign now'}
        tone={contractSigned ? 'good' : 'warn'}
      />

      {staffBadges.length === 0 ? (
        <Row
          Icon={IdCard}
          title="Staff badges"
          subtitle="No staff badges registered yet. Add your gate access list on the Staff tab."
          href="/exhibitor/portal/staff"
          cta="Open Staff"
          tone="neutral"
        />
      ) : (
        <div className="bg-white border border-neutral-200 rounded-2xl p-5">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-lg bg-[#cd2653]/10 text-[#cd2653] flex items-center justify-center shrink-0">
              <IdCard className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-neutral-900">Staff badges</p>
              <p className="text-xs text-neutral-500 mt-0.5">
                One PDF per staff member. Print and bring to the gate for entry.
              </p>
              <ul className="mt-3 space-y-2">
                {staffBadges.map((s, i) => {
                  const ready = Boolean(s.wc_order_id)
                  return (
                    <li
                      key={i}
                      className="flex items-center justify-between gap-3 text-sm border border-neutral-100 rounded-lg px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-neutral-900 truncate">{s.name}</p>
                        <p className="text-[11px] text-neutral-500 capitalize">{s.role || 'staff'}</p>
                      </div>
                      {ready ? (
                        <SafeDownloadLink
                          href={`/api/exhibitor/portal/badge/${s.wc_order_id}/pdf`}
                          filename={`CTH-Badge-${slug(s.name)}.pdf`}
                          className="inline-flex items-center gap-1.5 text-xs font-medium text-[#cd2653] border border-[#cd2653]/30 rounded-lg px-3 py-1.5 hover:bg-[#cd2653] hover:text-white transition-colors shrink-0 disabled:opacity-50"
                        >
                          <Download className="w-3.5 h-3.5" /> PDF
                        </SafeDownloadLink>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs text-neutral-400 shrink-0">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

type LucideIcon = typeof FileText

function Row({
  Icon,
  title,
  subtitle,
  href,
  cta,
  tone,
}: {
  Icon: LucideIcon
  title: string
  subtitle: string
  href: string
  cta: string
  tone: 'good' | 'warn' | 'neutral'
}) {
  const toneClass =
    tone === 'good'
      ? 'text-emerald-700 border-emerald-200 hover:bg-emerald-50'
      : tone === 'warn'
      ? 'text-[#cd2653] border-[#cd2653]/30 hover:bg-[#cd2653] hover:text-white'
      : 'text-neutral-700 border-neutral-200 hover:bg-neutral-50'
  // API routes are file downloads that can return a JSON error on failure; route
  // them through SafeDownloadLink so an error is never saved as a misnamed file.
  // Plain page-navigation hrefs (e.g. /exhibitor/portal/contract) stay anchors.
  const isDownload = href.startsWith('/api/')
  const ctaClass = `inline-flex items-center gap-1.5 text-sm font-medium rounded-lg px-3 py-2 border transition-colors shrink-0 ${toneClass}`
  return (
    <div className="bg-white border border-neutral-200 rounded-2xl p-5 flex items-start gap-4">
      <div className="w-10 h-10 rounded-lg bg-[#cd2653]/10 text-[#cd2653] flex items-center justify-center shrink-0">
        <Icon className="w-5 h-5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-neutral-900">{title}</p>
        <p className="text-xs text-neutral-500 mt-0.5">{subtitle}</p>
      </div>
      {isDownload ? (
        <SafeDownloadLink href={href} filename={`CTH-${slug(title)}.pdf`} className={`${ctaClass} disabled:opacity-50`}>
          <Download className="w-4 h-4" /> {cta}
        </SafeDownloadLink>
      ) : (
        <a href={href} className={ctaClass}>
          <Download className="w-4 h-4" /> {cta}
        </a>
      )}
    </div>
  )
}
