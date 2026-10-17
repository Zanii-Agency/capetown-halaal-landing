import type { Metadata } from 'next'
import { FAQ, type FaqKey } from '@/lib/festival-brain/faq'

// Replaces the site chat bot (2026-10-17, Taona: "just have an FAQ on the
// platform"). Same canonical answers the bot used, read straight from faq.ts so
// the two can never drift.

export const metadata: Metadata = { title: 'FAQ | Young at Heart Festival 2026' }

const QUESTIONS: Record<FaqKey, string> = {
  dates: 'When is the festival?',
  venue: 'Where is it?',
  opening_hours: 'What are the opening hours?',
  ticket_price: 'How much are tickets?',
  buy_tickets: 'Where do I buy tickets?',
  ticket_types: 'What ticket types are there?',
  gate_tickets: 'Can I buy tickets at the gate?',
  gift_tickets: 'Can I buy tickets as a gift?',
  ticket_delivery: 'How do I receive my ticket?',
  ticket_collection: 'Do I need to collect my ticket?',
  ticket_exchange: 'Can I change my ticket?',
  ticket_transfer: 'Can I give my ticket to someone else?',
  ticket_scan_issue: 'What if my ticket does not scan?',
  refund_policy: 'What is the refund policy?',
  payment_methods: 'How can I pay?',
  entry_requirements: 'What do I need to get in?',
  kids_free_age: 'Do children need tickets?',
  kids_play_area: 'Is there a kids area?',
  parking: 'Is there parking?',
  accessibility: 'Is the venue accessible?',
  halaal_cert: 'Is the food halaal?',
  vendor_apply: 'How do I apply to be a vendor?',
  vendor_approval_time: 'How long does vendor approval take?',
  stall_sizes: 'What stall sizes are available?',
  stall_allocation: 'When do I get my stall allocation?',
  electricity: 'Can I get electricity at my stall?',
  vendor_table_chairs: 'Do stalls come with tables and chairs?',
  vendor_payment_method: 'How do vendors pay?',
  vendor_part_payment: 'Can vendors pay in parts?',
  vendor_invoice_vat: 'Can I get an invoice?',
  vendor_after_payment: 'What happens after I pay?',
  vendor_gate_passes: 'How do vendor gate passes work?',
  contact: 'How do I contact the team?',
  website: 'What is the website?',
  instagram: 'Are you on Instagram?',
}

const GROUPS: Array<{ title: string; keys: FaqKey[] }> = [
  { title: 'The festival', keys: ['dates', 'venue', 'opening_hours', 'entry_requirements', 'kids_free_age', 'kids_play_area', 'parking', 'accessibility', 'halaal_cert'] },
  { title: 'Tickets', keys: ['ticket_price', 'buy_tickets', 'ticket_types', 'gate_tickets', 'gift_tickets', 'ticket_delivery', 'ticket_collection', 'ticket_exchange', 'ticket_transfer', 'ticket_scan_issue', 'refund_policy', 'payment_methods'] },
  { title: 'Vendors', keys: ['vendor_apply', 'vendor_approval_time', 'stall_sizes', 'stall_allocation', 'electricity', 'vendor_table_chairs', 'vendor_payment_method', 'vendor_part_payment', 'vendor_invoice_vat', 'vendor_after_payment', 'vendor_gate_passes'] },
  { title: 'Contact', keys: ['contact', 'website', 'instagram'] },
]

export default function FaqPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-3xl font-bold mb-2">Frequently asked questions</h1>
      <p className="text-neutral-600 mb-10">Young at Heart Festival 2026. Still need help? Email support@youngatheart.co.za.</p>
      {GROUPS.map((g) => (
        <section key={g.title} className="mb-10">
          <h2 className="text-xl font-semibold mb-3">{g.title}</h2>
          <div className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
            {g.keys.filter((k) => FAQ[k]).map((k) => (
              <details key={k} className="group px-4 py-3">
                <summary className="cursor-pointer list-none font-medium flex justify-between gap-4">
                  {QUESTIONS[k]}<span className="text-neutral-400 group-open:rotate-45 transition-transform">+</span>
                </summary>
                <p className="mt-2 text-neutral-700 leading-relaxed">{FAQ[k].answer}</p>
              </details>
            ))}
          </div>
        </section>
      ))}
    </main>
  )
}
