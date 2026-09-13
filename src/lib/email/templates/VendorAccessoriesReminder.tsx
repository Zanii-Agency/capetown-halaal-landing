import {
  EmailLayout,
  Heading,
  Paragraph,
  Signoff,
  Divider,
  Button,
} from '../components'
import { brand } from '../brand'
import { formatRand } from '@/lib/payments/pricing'

interface AccessoryLine { label: string; amount: number }

interface VendorAccessoriesReminderProps {
  contactName: string
  businessName: string
  owing: number
  items: AccessoryLine[]   // exactly what they selected (appliances + furniture)
  payUrl: string
  reminderNumber: number   // 1, 2, 3+ (tone hardens slightly)
}

const TONES: Record<number, { heading: string; lede: string }> = {
  1: {
    heading: 'One more payment: your accessory electricity',
    lede: `Your stall fee is paid and your booth is confirmed, thank you. There is one separate charge still outstanding: the electricity for the appliances you booked. Please settle it to keep your power connection confirmed.`,
  },
  2: {
    heading: 'Reminder: accessory electricity still due',
    lede: `A quick reminder that the electricity for the appliances you booked is still outstanding. Your stall is confirmed; this is the separate power charge. Please settle it below.`,
  },
  3: {
    heading: 'Please settle your accessory electricity',
    lede: `Your accessory electricity is still outstanding. Power for the appliances you booked can only be guaranteed once this is paid. Please settle it as soon as you can.`,
  },
}

export function VendorAccessoriesReminder({
  contactName,
  businessName,
  owing,
  items,
  payUrl,
  reminderNumber,
}: VendorAccessoriesReminderProps) {
  const tone = TONES[Math.min(Math.max(reminderNumber, 1), 3)]
  const firstName = (contactName || 'there').trim().split(/\s+/)[0] || 'there'
  return (
    <EmailLayout preview={`Accessory electricity due for ${businessName}: ${formatRand(owing)}`}>
      <Heading>{tone.heading}</Heading>
      <Paragraph>Hi {firstName},</Paragraph>
      <Paragraph>{tone.lede}</Paragraph>

      <Divider />
      <Paragraph>
        <strong>What is outstanding for {businessName}</strong>
      </Paragraph>
      {items.map((it, i) => (
        <Paragraph key={i}>
          <span style={{ color: brand.color.muted }}>{it.label}</span>
          <span style={{ float: 'right', fontWeight: 600 }}>{formatRand(it.amount)}</span>
        </Paragraph>
      ))}
      <Divider />
      <Paragraph>
        <strong>Total accessory electricity due</strong>
        <span style={{ float: 'right', fontWeight: 700, color: brand.color.magenta }}>{formatRand(owing)}</span>
      </Paragraph>

      <Paragraph>
        You can pay this in your vendor portal. Card payers pay by card, and if you paid your stall fee by EFT you
        will see the bank details with an accessories reference to use, then upload your proof of payment.
      </Paragraph>
      <Button href={payUrl}>Pay accessory electricity</Button>

      <Divider />
      <Paragraph>
        <strong>Need more power?</strong> You can add more appliances too, from the same list you chose at
        signup. Log in to your portal to see every appliance and its price and add what you need, or message us
        on WhatsApp for more information and we will help.
      </Paragraph>
      <Signoff>
        Warm regards,<br />
        The Young at Heart Festival team
      </Signoff>
    </EmailLayout>
  )
}
