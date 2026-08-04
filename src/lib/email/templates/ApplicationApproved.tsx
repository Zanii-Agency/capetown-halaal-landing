import {
  EmailLayout,
  Heading,
  Subheading,
  Paragraph,
  Signoff,
  Divider,
  InlineLink,
  InfoCard,
  CredBox,
  SuccessBadge,
  EventDetails,
  Steps,
  Button,
} from '../components'
import { brand } from '../brand'

interface ApplicationApprovedProps {
  businessName: string
  contactName: string
  email: string
  boothTier?: string
  applicationId?: string
  tempPassword?: string
  loginUrl?: string
  paymentDueDate?: string
}

export function ApplicationApproved({
  businessName,
  contactName,
  email,
  boothTier,
  tempPassword,
  loginUrl = 'https://cthalaal.co.za/exhibitor/login',
}: ApplicationApprovedProps) {
  return (
    <EmailLayout preview="Your vendor application has been approved, Young at Heart Festival 2026">
      <SuccessBadge>✓ APPLICATION APPROVED</SuccessBadge>

      <Heading>Welcome aboard, {contactName}!</Heading>

      <Paragraph>
        Great news. Your exhibitor application for <strong>{businessName}</strong> has been
        approved for Young at Heart Festival 2026.
      </Paragraph>

      {boothTier && <InfoCard label="Booth Preference" value={boothTier} />}

      {tempPassword && (
        <>
          <Divider />
          <Subheading>Your login credentials</Subheading>
          <Paragraph>
            Sign in to your exhibitor portal with the email and temporary password below.
            You will be asked to set a new password on first login.
          </Paragraph>
          <CredBox
            email={email}
            password={tempPassword}
            note="This password expires in 48 hours."
          />
        </>
      )}

      <Divider />

      <Subheading>Next steps</Subheading>
      <Steps
        items={[
          'Log into your exhibitor portal using the credentials above.',
          'Confirm the terms & conditions, then complete your stall fee payment.',
          'Upload your compliance documents and register your gate staff.',
          'The organisers allocate your stall position; you will see it in your portal.',
        ]}
      />

      <Button href={loginUrl}>Log in to Exhibitor Portal →</Button>

      <Divider />

      <Subheading>Manage your stall anytime</Subheading>
      <Paragraph>
        You do not have to wait for us. Message us on WhatsApp, on the same number
        that sent you your approval, or log into your portal to check your stall
        size and price, see your payment due date, get your invoice, or upload your
        documents. Just ask and you will get an answer straight away.
      </Paragraph>

      <Divider />

      <EventDetails
        rows={[
          `📅  ${brand.contact.dates}`,
          `📍  ${brand.contact.venue}`,
          '⏰  Fri 2PM–11PM · Sat & Sun 11AM–11PM',
        ]}
      />

      <Paragraph>
        Questions? Contact us at{' '}
        <InlineLink href={`mailto:${brand.contact.email}`}>{brand.contact.email}</InlineLink>.
      </Paragraph>

      <Signoff>
        See you at the festival!
        <br />
        <strong>The Young at Heart Team</strong>
      </Signoff>
    </EmailLayout>
  )
}

export default ApplicationApproved
