import {
  EmailLayout,
  Heading,
  Subheading,
  Paragraph,
  Signoff,
  Divider,
  InlineLink,
  InfoCard,
  EventDetails,
  Steps,
} from '../components'
import { brand } from '../brand'

interface ApplicationRejectedProps {
  contactName: string
  businessName: string
  /** Admin-typed reason. When present the body leads with this reason instead
   *  of the generic capacity narrative (which is wrong for a duplicate / an
   *  incomplete / an out-of-scope reject). */
  reason?: string
}

/**
 * Outcome email for applications that are not approved this year.
 * Tone: warm, respectful, never cold. Mirrors the delay-notice voice so the
 * whole applicant journey feels like one brand. Plain-text fallback lives in
 * the route; this is the branded HTML body.
 */
export function ApplicationRejected({
  contactName,
  businessName,
  reason,
}: ApplicationRejectedProps) {
  return (
    <EmailLayout preview="An update on your Young at Heart Festival 2026 application">
      <Heading>An update on your application</Heading>

      <Paragraph>Hi {contactName},</Paragraph>

      {reason ? (
        <>
          <Paragraph>
            Thank you for applying to trade at Young at Heart Festival 2026 with{' '}
            <strong>{businessName}</strong>, and for taking the time to submit your application.
          </Paragraph>
          <Paragraph>
            After a careful review, we are not able to offer {businessName} a trading spot at
            this year&apos;s festival. The reason from our review team:
          </Paragraph>
          <InfoCard label="Reason" value={reason} />
          <Paragraph>
            Your details stay on file, and you are welcome to apply again for future events.
          </Paragraph>
        </>
      ) : (
        <>
          <Paragraph>
            Thank you for applying to trade at Young at Heart Festival 2026 with{' '}
            <strong>{businessName}</strong>, and for your patience while our selection committee
            worked through every submission.
          </Paragraph>
          <Paragraph>
            We received an overwhelming number of vendor applications this year, far beyond the
            spaces we have available. After a careful and fair review, we are not able to offer{' '}
            {businessName} a trading spot at this year&apos;s festival.
          </Paragraph>
          <Paragraph>
            Please know this is not a reflection of your business. With limited stalls and so many
            strong applications, many wonderful vendors could not be accommodated this time.
          </Paragraph>

          <Subheading>What this means for you</Subheading>
          <Steps
            items={[
              'There is nothing further you need to do for the 2026 festival.',
              'Your details stay on file, and we would warmly welcome a fresh application for future events.',
              'You are still very welcome to join us as a visitor, it is going to be a special three days.',
            ]}
          />
        </>
      )}

      <Paragraph>
        If you would like any feedback, or your business details have changed, simply reply to
        this email and a member of our team will be glad to help.
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
        Thank you again for wanting to be part of Young at Heart Festival 2026. We hope to see
        you there.
        <br />
        <br />
        Warm regards,
        <br />
        <strong>The Young at Heart Festival Team</strong>
      </Signoff>
    </EmailLayout>
  )
}

export default ApplicationRejected
