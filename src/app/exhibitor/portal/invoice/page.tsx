import { getExhibitorContext } from '@/lib/exhibitor'
import { parsePortalState } from '@/lib/portal-state'
import { computeVendorPricing, formatRand } from '@/lib/payments/pricing'
import { paymentReference } from '@/lib/payments'
import { brand } from '@/lib/email/brand'
import { PrintBar } from './PrintBar'

export const dynamic = 'force-dynamic'

// Print-styled HTML invoice. Same brand DNA as the email templates
// (Fraunces serif, warm copy, crimson accents). Browser print → PDF.
export default async function InvoicePage() {
  const ctx = await getExhibitorContext()
  if (!ctx?.application) {
    return (
      <div className="p-12 text-center text-neutral-500">
        Sign in to view your invoice.
      </div>
    )
  }
  const app = ctx.application
  const state = parsePortalState(app.admin_notes as string)
  const pricing = computeVendorPricing({
    preferred_booth_tier: app.preferred_booth_tier as string,
    special_requirements: app.special_requirements,
  })
  const status = state.payment?.status || 'none'
  // 'collected' (EFT interim) shows as PAID to the vendor, same as a real 'paid'.
  const isPaid = status === 'paid' || status === 'collected'
  const total = state.payment?.amount ?? pricing.total
  const reference = state.payment?.reference || paymentReference(app.id as string)
  const providerRef = state.payment?.provider_ref || ''
  const paidStamp = state.payment?.paid_at || state.payment?.eft_collected_at
  const paidAt = paidStamp
    ? new Date(paidStamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
    : null
  const issuedAt = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })

  return (
    <div className="bg-white text-neutral-900">
      {/* Print/screen styles + page setup */}
      <style>{`
        @page { size: A4; margin: 18mm; }
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; }
        }
        .invoice-fraunces { font-family: 'Fraunces', 'Times New Roman', Georgia, serif; }
      `}</style>

      <PrintBar businessName={String(app.business_name)} />

      <div className="max-w-3xl mx-auto px-8 py-10">
        {/* Header */}
        <header className="flex items-start justify-between pb-6 border-b-2 border-[#cd2653]">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-[#cd2653] font-semibold">Tax Invoice</p>
            <h1 className="invoice-fraunces text-4xl text-neutral-900 mt-1">Young at Heart Festival 2026</h1>
            <p className="text-sm text-neutral-500 mt-1">{brand.contact.dates} · {brand.contact.venue}</p>
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-wider text-neutral-400">Invoice #</p>
            <p className="font-mono text-lg font-semibold mt-0.5">{reference}</p>
            <p className="text-xs text-neutral-500 mt-2">Issued {issuedAt}</p>
            {isPaid && (
              <p className="inline-block mt-2 bg-green-50 text-green-700 border border-green-200 rounded-full px-3 py-0.5 text-xs font-semibold">
                PAID {paidAt && `· ${paidAt}`}
              </p>
            )}
          </div>
        </header>

        {/* Billed to + From */}
        <section className="grid grid-cols-2 gap-8 mt-8 text-sm">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-neutral-400 mb-2">Billed to</p>
            <p className="font-semibold text-neutral-900">{String(app.business_name)}</p>
            <p className="text-neutral-600">{String(app.contact_name)}</p>
            <p className="text-neutral-600">{String(app.email)}</p>
            {app.whatsapp_number ? <p className="text-neutral-600">{String(app.whatsapp_number)}</p> : null}
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-neutral-400 mb-2">From</p>
            <p className="font-semibold text-neutral-900">Young at Heart Festival</p>
            <p className="text-neutral-600">{brand.contact.email}</p>
            <p className="text-neutral-600">{brand.contact.phone}</p>
          </div>
        </section>

        {/* Line items */}
        <section className="mt-10">
          <p className="text-[10px] uppercase tracking-wider text-neutral-400 mb-3">Items</p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-neutral-500">
                <th className="text-left font-medium pb-2">Description</th>
                <th className="text-right font-medium pb-2 w-16">Qty</th>
                <th className="text-right font-medium pb-2 w-32">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-neutral-100">
                <td className="py-3">
                  <p className="font-medium text-neutral-900">{pricing.stallLabel}</p>
                  <p className="text-xs text-neutral-500 mt-0.5">Stall fee (3 days · setup access)</p>
                </td>
                <td className="text-right py-3">1</td>
                <td className="text-right py-3">{formatRand(pricing.stallPrice)}</td>
              </tr>
              {pricing.electricalItems.map((it, i) => (
                <tr key={i} className="border-b border-neutral-100">
                  <td className="py-3">
                    <p className="text-neutral-900">{it.label}</p>
                    <p className="text-xs text-neutral-500 mt-0.5">Electrical add-on</p>
                  </td>
                  <td className="text-right py-3">{it.qty}</td>
                  <td className="text-right py-3">{formatRand(it.amount)}</td>
                </tr>
              ))}
              {pricing.chairsQty > 0 && (
                <tr className="border-b border-neutral-100">
                  <td className="py-3">
                    <p className="text-neutral-900">Chairs hired</p>
                    <p className="text-xs text-neutral-500 mt-0.5">Furniture hire</p>
                  </td>
                  <td className="text-right py-3">{pricing.chairsQty}</td>
                  <td className="text-right py-3">{formatRand(pricing.chairsAmount)}</td>
                </tr>
              )}
              {pricing.tablesQty > 0 && (
                <tr className="border-b border-neutral-100">
                  <td className="py-3">
                    <p className="text-neutral-900">Tables hired</p>
                    <p className="text-xs text-neutral-500 mt-0.5">Furniture hire</p>
                  </td>
                  <td className="text-right py-3">{pricing.tablesQty}</td>
                  <td className="text-right py-3">{formatRand(pricing.tablesAmount)}</td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2} className="pt-6 text-right font-semibold">Total due</td>
                <td className="pt-6 text-right invoice-fraunces text-2xl font-semibold text-[#cd2653]">{formatRand(total)}</td>
              </tr>
            </tfoot>
          </table>
        </section>

        {/* Payment block */}
        {isPaid && (
          <section className="mt-8 p-5 bg-green-50 border border-green-200 rounded-2xl">
            <p className="text-xs uppercase tracking-wider text-green-700 font-semibold">Payment</p>
            <p className="text-sm text-neutral-700 mt-1">
              Paid {paidAt && `on ${paidAt}`}. Reference <span className="font-mono">{reference || providerRef}</span>.
            </p>
          </section>
        )}

        {/* Footer */}
        <footer className="mt-12 pt-6 border-t border-neutral-200 text-xs text-neutral-500 leading-relaxed">
          <p>This invoice is issued for the Young at Heart Festival 2026, held {brand.contact.dates} at {brand.contact.venue}.</p>
          <p className="mt-2">Stalls are non-refundable per the cancellation policy. Questions: {brand.contact.email}.</p>
        </footer>
      </div>
    </div>
  )
}
