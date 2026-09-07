// CTH Vendor Contract 2026 — single source of truth for the contract copy.
// Used by:
//   - /exhibitor/portal/contract (the page the vendor reads + signs)
//   - /api/exhibitor/contract/sign (renders the same copy + the signature
//     image into a themed PDF for storage)
// Edits land in BOTH places automatically.
//
// Rewritten from the legacy 2025 Word doc:
//   - Date corrected: 19-21 Dec 2025 → 11-13 Dec 2026
//   - Orphan clause completed: "In the case of damages, it must be..."
//     → reported in writing to the organisers within 48 hours of the incident.
//   - No-em-dashes law applied (commas/periods/colons only).

export const CONTRACT_VERSION = 'cth-vendor-2026-v1'
export const CONTRACT_DATE_RANGE = '11-13 December 2026'
export const CONTRACT_VENUE = 'Youngsfield Military Base, Cape Town'

export interface ContractSection {
  heading?: string
  intro?: string
  bullets?: string[]
}

export const CONTRACT_SECTIONS: ContractSection[] = [
  {
    intro:
      'This is a contract between Cape Town Halaal and Young at Heart Festival (referred to as "we" and "the organisers") and the Stall Holder (referred to as the "Vendor") for trading at the festival on ' +
      CONTRACT_DATE_RANGE +
      ' at ' +
      CONTRACT_VENUE +
      '.',
  },
  {
    heading: 'Stall preparation and trading rules',
    bullets: [
      'Each Vendor must prepare their own stall on the marked area provided by the organisers.',
      'Each Vendor will only be given the empty space they applied and paid for.',
      'All marketing materials and space design are the responsibility of the Vendor.',
      'Each Vendor is responsible for requesting power points in advance; only those requested in the application form will be considered.',
      'Vendors will be allocated a plot per the official layout, according to their requirements and what they are selling. No changing of plots is permitted without the organisers consent. Setting up on a different plot will require immediate relocation to the allocated one.',
      'Stalls must be occupied at all times during trading hours until the festival ends. Vendors may not close up or leave during trading hours even if products are sold out. Vendors may only leave once trading hours have ended or if indicated by the organisers.',
    ],
  },
  {
    heading: 'Liability and insurance',
    bullets: [
      'Under no circumstances shall Cape Town Halaal Festival be liable for any lost profits or any incidental, special, indirect, unintended or consequential damages whatsoever for any of their acts or omissions, whether or not appraised of the possibility of such damages. We make no representation or warranties, expressed or implied, regarding the number of persons who will attend the event or any other matter.',
      'Vendors should take all possible precautions to protect their own property, including liability insurance for their vending space.',
      'We are not responsible for damaged goods resulting from use of appliances or machineries from third party suppliers. Please ensure you have adequate insurance for any mishaps. In the case of damages, the incident must be reported in writing to the organisers within 48 hours of the occurrence.',
      'We are not responsible for stolen property or damaged merchandise while the Vendor is on the festival site or during closing times.',
      'We are not responsible or liable for any injuries or accidents to self or property occurring while the Vendor is on site, transporting or removing products.',
      'The Vendor is responsible for notifying visitors of potential hazards that could result from their products, for example food allergies.',
    ],
  },
  {
    heading: 'Health, safety and compliance',
    bullets: [
      'Food and Dessert Vendors (anything edible) must comply with health regulations. Your COA and Hawkers License must be displayed in your stall while trading during the festival. Failure to display valid documents during inspection may result in removal without refund.',
      'On Friday morning of the festival, Vendors must be set up and ready to trade 1 hour before the festival starts and attend the compulsory morning briefing session.',
      'On Sunday, Vendors must be on site half an hour prior to trading time.',
      'No vehicle of any Vendor may be on the premises in the vicinity of the stalls as and when gates open for festival goers. Failure to arrive on time will result in the Vendor not being allowed to trade and shall be fined R500. No stall refunds will be granted.',
      'If a Vendor is found selling products not permitted, they will be required to vacate the festival immediately.',
      'No refunds will be granted as a result of the health inspector checking your stall on site and declining you to trade.',
    ],
  },
  {
    heading: 'Site upkeep and conduct',
    bullets: [
      'It is the responsibility of the Vendor to clean up their allocated area before and after the festival. The festival area must be kept neat and tidy at all times.',
      'Vendors agree and give full consent to the organisers and the hired photographer to take pictures of your stall and products, to be fully usable for promotional use.',
    ],
  },
  {
    heading: 'Force majeure and severe weather',
    bullets: [
      'In the event of force majeure, the contract will be suspended for the entire period during which the force majeure continues and may, at the discretion of the organisers, be cancelled or postponed.',
      'In the event of severe weather that may disrupt the event or prevent it from being held, every effort will be made to change the date. The vendor fee will not be refunded.',
    ],
  },
  {
    heading: 'Confidentiality',
    intro: 'The organisers and the Vendor agree NOT to:',
    bullets: [
      'Disclose, in writing or verbally, information regarding their financial affairs, contractual rights and obligations, potential and actual relations with customers, suppliers and staff, business systems, projections, strategies and budgets, intellectual property, and other necessary information deemed confidential.',
      'Publicly defame or cause harm to the reputation of the other in bad faith.',
    ],
  },
  {
    heading: 'Disputes',
    intro: 'Where a dispute arises between the organisers and the Vendor:',
    bullets: [
      'In respect of this agreement, the aggrieved party shall notify the other, in writing, of the dispute within 5 days of the matter arising.',
      'Thereafter, the parties shall negotiate in good faith to settle the dispute as expeditiously as possible.',
      'Failure to comply with this condition shall be deemed acknowledgement on the part of the parties that the event occurred without incident.',
      'In the event that the Vendor institutes any legal proceedings without first agreeing to a meeting to attempt resolution, and should proceedings be in favour of the organisers, the Vendor accepts that the organisers will be entitled to recover time, travel, loss of income and representation costs incurred at a rate of R450 per hour (excl. VAT).',
    ],
  },
  {
    heading: 'Cancellation',
    intro: 'If the Vendor has paid their fees and cannot trade for any reason, the following applies:',
    bullets: [
      '14 weeks before the festival: 100% refund',
      '10 weeks before the festival: 50% refund',
      '8 weeks before the festival: 0% refund',
    ],
  },
]

export const CONTRACT_ACCEPTANCE_LINE =
  'I fully understand and comprehend the above and wish to comply with the above in order to trade at the Cape Town Halaal Festival on ' +
  CONTRACT_DATE_RANGE +
  '.'

// The Cancellation (refund) clause of the signed contract, formatted for a
// WhatsApp / chat message. Sourced straight from CONTRACT_SECTIONS so what the
// bot tells a withdrawing paid vendor and what they actually signed can never
// drift. Taona 2026-09-07: a vendor who has paid and wants to withdraw must be
// told how it works per the terms they signed.
export function cancellationTermsText(): string {
  const sec = CONTRACT_SECTIONS.find((s) => s.heading === 'Cancellation')
  if (!sec) return ''
  const bullets = (sec.bullets || []).map((b) => `• ${b}`).join('\n')
  return [sec.intro, bullets].filter(Boolean).join('\n')
}
