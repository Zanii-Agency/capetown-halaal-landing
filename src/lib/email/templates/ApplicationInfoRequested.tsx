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
} from '../components'
import { brand } from '../brand'

interface ApplicationInfoRequestedProps {
  contactName: string
  businessName: string
  /** Optional specifics the committee needs — rendered as bullet steps when present. */
  requested?: string[]
  /** Admin-typed free-text note. Each non-empty line becomes a bullet, taking
   *  precedence over the generic default list. */
  reason?: string
}

/**
 * Outcome email when the committee needs more detail before deciding.
 * Branded HTML body; the route carries a plain-text fallback.
 */
export function ApplicationInfoRequested({
  contactName,
  businessName,
  requested,
  reason,
}: ApplicationInfoRequestedProps) {
  const reasonItems = (reason || '')
    .split('\n')
    .map((l) => l.replace(/^[-•\s]+/, '').trim())
    .filter(Boolean)
  const items =
    reasonItems.length > 0
      ? reasonItems
      : requested && requested.length > 0
      ? requested
      : [
          'A clear description of what you plan to sell or showcase.',
          'A few photos of your products, stall, or previous setups.',
          'Your trading licence or relevant certification, if applicable.',
        ]

  return (
    <EmailLayout preview="A little more information needed, Young at Heart Festival 2026">
      <Heading>We need a little more information</Heading>

      <Paragraph>Hi {contactName},</Paragraph>
      <Paragraph>
        Thank you for applying to trade at Young at Heart Festival 2026 with{' '}
        <strong>{businessName}</strong>. Your application is moving through review, and our
        committee just needs a little more detail before we can finalise a decision.
      </Paragraph>

      <Subheading>What we need from you</Subheading>
      <Steps items={items} />

      <Paragraph>
        Simply <strong>reply to this email</strong> with the details above and we will pick your
        application straight back up. The sooner we receive it, the sooner we can confirm your
        outcome.
      </Paragraph>

      <Divider />

      <EventDetails
        rows={[
          `📅  ${brand.contact.dates}`,
          `📍  ${brand.contact.venue}`,
          '🎪  350+ Vendors · 25,000+ Visitors',
        ]}
      />

      <Paragraph>
        Questions? Reach out at{' '}
        <InlineLink href={`mailto:${brand.contact.email}`}>{brand.contact.email}</InlineLink>{' '}
        or call {brand.contact.phone}.
      </Paragraph>

      <Signoff>
        Thank you, and we look forward to hearing back from you.
        <br />
        <br />
        Warm regards,
        <br />
        <strong>The Young at Heart Festival Team</strong>
      </Signoff>
    </EmailLayout>
  )
}

export default ApplicationInfoRequested
