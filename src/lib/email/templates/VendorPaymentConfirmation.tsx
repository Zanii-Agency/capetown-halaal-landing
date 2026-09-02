import {
  EmailLayout,
  Heading,
  Subheading,
  Paragraph,
  Signoff,
  Divider,
  InlineLink,
  EventDetails,
  Steps,
  Button,
  SuccessBadge,
} from '../components'
import { brand } from '../brand'
import { formatRand, type VendorPricing } from '@/lib/payments/pricing'

interface VendorPaymentConfirmationProps {
  contactName: string
  businessName: string
  amount: number
  providerRef: string
  invoiceUrl: string
  portalUrl: string
  /** Reference / invoice number shown on the receipt block. */
  reference?: string
  /** Paid date string (e.g. "10 June 2026"). Falls back to today. */
  paidDate?: string
  /** Full line-item breakdown from computeVendorPricing. Optional, but when
   *  present we render the itemised invoice inline so the email IS the receipt. */
  pricing?: VendorPricing
}

// Inline-CSS chrome for cross-client safety (Gmail strips <style>).
const TABLE: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse', fontFamily: 'Inter, Arial, sans-serif', fontSize: '14px',
  border: '1px solid #E5DCC4', borderRadius: '12px', overflow: 'hidden',
}
const TH: React.CSSProperties = {
  textAlign: 'left', padding: '12px 16px', fontSize: '11px', letterSpacing: '0.12em',
  textTransform: 'uppercase', color: '#7d7770', background: '#F6F2E8', borderBottom: '1px solid #E5DCC4',
  fontWeight: 700,
}
const THR: React.CSSProperties = { ...TH, textAlign: 'right' }
const TD: React.CSSProperties = {
  padding: '12px 16px', borderBottom: '1px solid #F2EBD8', color: '#1B1A17',
}
const TDR: React.CSSProperties = { ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
const TDT: React.CSSProperties = {
  padding: '16px', textAlign: 'right', fontWeight: 700, fontSize: '15px', color: '#cd2653',
  background: '#FDFAF1', borderTop: '2px solid #cd2653',
}

/**
 * Payment-confirmation + welcome email. Tone matches ApplicationApproved.
 * When pricing is provided, the full itemised invoice is rendered inline so the
 * email itself serves as the receipt (Taona's ask: don't make them click into
 * the portal just to see the breakdown).
 */
export function VendorPaymentConfirmation({
  contactName,
  businessName,
  amount,
  providerRef,
  invoiceUrl,
  portalUrl,
  reference,
  paidDate,
  pricing,
}: VendorPaymentConfirmationProps) {
  const issued = paidDate || new Date().toLocaleDateString('en-GB', {
    day: '2-digit', month: 'long', year: 'numeric',
  })
  const invoiceNum = reference || providerRef || ''

  return (
    <EmailLayout preview={`Payment received for ${businessName}, Young at Heart Festival 2026`}>
      <Heading>Payment received. Your spot is reserved.</Heading>

      <SuccessBadge>Payment received</SuccessBadge>

      <Paragraph>Hi {contactName},</Paragraph>
      <Paragraph>
        Thank you. We&apos;ve received your payment for <strong>{businessName}</strong>, and your
        place at Young at Heart Festival 2026 is reserved.
      </Paragraph>
      <Paragraph>
        Your exact stall has not been allocated yet. We assign stall locations closer to the
        festival, and we will email you your stall as soon as it is confirmed. Please wait for that
        allocation before making any setup or layout plans. Welcome to the family.
      </Paragraph>

      {/* --- INLINE INVOICE --- */}
      <Subheading>Tax invoice</Subheading>

      <table style={{
        width: '100%', marginBottom: '20px', borderCollapse: 'collapse',
        fontFamily: 'Inter, Arial, sans-serif', fontSize: '13px',
      }}>
        <tbody>
          <tr>
            <td style={{ padding: '0 0 8px 0', color: '#7d7770' }}>Invoice #</td>
            <td style={{ padding: '0 0 8px 0', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#1B1A17' }}>
              {invoiceNum}
            </td>
          </tr>
          <tr>
            <td style={{ padding: '0 0 8px 0', color: '#7d7770' }}>Issued</td>
            <td style={{ padding: '0 0 8px 0', textAlign: 'right', color: '#1B1A17' }}>{issued}</td>
          </tr>
          <tr>
            <td style={{ padding: '0 0 8px 0', color: '#7d7770' }}>Billed to</td>
            <td style={{ padding: '0 0 8px 0', textAlign: 'right', color: '#1B1A17' }}>{businessName}</td>
          </tr>
        </tbody>
      </table>

      {pricing && (
        <table style={TABLE}>
          <thead>
            <tr>
              <th style={TH}>Description</th>
              <th style={THR}>Qty</th>
              <th style={THR}>Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={TD}>
                <div style={{ fontWeight: 600 }}>{pricing.stallLabel}</div>
                <div style={{ fontSize: '11px', color: '#7d7770', marginTop: '2px' }}>
                  Stall fee (3 days, setup access)
                </div>
              </td>
              <td style={TDR}>1</td>
              <td style={TDR}>{formatRand(pricing.stallPrice)}</td>
            </tr>
            {pricing.electricalItems.map((it, i) => (
              <tr key={i}>
                <td style={TD}>
                  <div>{it.label}</div>
                  <div style={{ fontSize: '11px', color: '#7d7770', marginTop: '2px' }}>Electrical add-on</div>
                </td>
                <td style={TDR}>{it.qty}</td>
                <td style={TDR}>{formatRand(it.amount)}</td>
              </tr>
            ))}
            {pricing.chairsQty > 0 && (
              <tr>
                <td style={TD}>
                  <div>Chairs hired</div>
                  <div style={{ fontSize: '11px', color: '#7d7770', marginTop: '2px' }}>Furniture hire</div>
                </td>
                <td style={TDR}>{pricing.chairsQty}</td>
                <td style={TDR}>{formatRand(pricing.chairsAmount)}</td>
              </tr>
            )}
            {pricing.tablesQty > 0 && (
              <tr>
                <td style={TD}>
                  <div>Tables hired</div>
                  <div style={{ fontSize: '11px', color: '#7d7770', marginTop: '2px' }}>Furniture hire</div>
                </td>
                <td style={TDR}>{pricing.tablesQty}</td>
                <td style={TDR}>{formatRand(pricing.tablesAmount)}</td>
              </tr>
            )}
            <tr>
              <td colSpan={2} style={{ ...TDT, textAlign: 'right' as const }}>Total paid</td>
              <td style={TDT}>{formatRand(amount)}</td>
            </tr>
          </tbody>
        </table>
      )}

      <Paragraph>
        {/* No payment method shown to the vendor: acknowledge the payment only.
            Method (Yoco / EFT) is internal reconciliation detail (Taona 2026-07-25). */}
        <strong>Reference:</strong> <span style={{ fontFamily: 'monospace' }}>{invoiceNum}</span>
        <br />
        <strong>Status:</strong> <span style={{ color: '#1f7050', fontWeight: 700 }}>PAID, {issued}</span>
      </Paragraph>

      <Button href={invoiceUrl}>View &amp; download a printable copy</Button>

      <Divider />

      <Subheading>What happens next</Subheading>
      <Steps
        items={[
          'Wait for your stall allocation. We assign and confirm stall locations closer to the festival, and you will get an email the moment yours is set. No action needed from you on this.',
          <>
            Log in to your exhibitor portal:{' '}
            <InlineLink href={portalUrl}>{portalUrl}</InlineLink>
          </>,
          'Upload your halaal certificate and any outstanding documents.',
          'Add your staff (we issue gate passes from this list).',
          'Watch your portal Announcements for setup times and load-in details closer to the festival.',
        ]}
      />

      <Divider />

      <EventDetails
        rows={[
          `📅  ${brand.contact.dates}`,
          `📍  ${brand.contact.venue}`,
          '🎪  350+ Vendors · 25,000+ Visitors',
        ]}
      />

      <Paragraph>
        Questions? Reach the team at{' '}
        <InlineLink href={`mailto:${brand.contact.email}`}>{brand.contact.email}</InlineLink> or call{' '}
        {brand.contact.phone}.
      </Paragraph>

      <Signoff>
        We can&apos;t wait to have you with us.
        <br />
        <br />
        Warm regards,
        <br />
        <strong>The Young at Heart Festival Team</strong>
      </Signoff>
    </EmailLayout>
  )
}

export default VendorPaymentConfirmation
