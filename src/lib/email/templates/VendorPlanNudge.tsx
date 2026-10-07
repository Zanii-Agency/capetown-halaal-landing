import { EmailLayout, Heading, Paragraph, Signoff, Button } from '../components'

// Weekly "pay in instalments" nudge (Wednesdays, 30 Sep to 4 Nov 2026). Copy is
// the operator's approved wording; do not add dashes (Law 7).
export function VendorPlanNudge({ contactName }: { contactName: string }) {
  return (
    <EmailLayout preview="An easier way to pay your stall fees">
      <Heading>Hi {contactName},</Heading>
      <Paragraph>
        We know your stall fees are due, and we understand that paying the full amount all
        at once can sometimes feel overwhelming.
      </Paragraph>
      <Paragraph>
        But did you know that we have now made it easier for our vendors to pay their stall
        fees off in instalments?
      </Paragraph>
      <Paragraph>
        If this is something you would like to take advantage of, please contact us on
        WhatsApp at +27 68 227 5246 and let us know that you would like to create a payment plan.
      </Paragraph>
      <Button href="https://wa.me/27682275246">WhatsApp us</Button>
      <Paragraph>
        WhatsApp is the quickest way for us to discuss the available options with you and
        work out the payment plan details together.
      </Paragraph>
      <Paragraph>
        We hope this makes things a little easier and helps you stay on track with your event
        preparations. We look forward to having you with us!
      </Paragraph>
      <Signoff>
        Kind regards,
        <br />
        <strong>Young at Heart Festival Team</strong>
      </Signoff>
    </EmailLayout>
  )
}
