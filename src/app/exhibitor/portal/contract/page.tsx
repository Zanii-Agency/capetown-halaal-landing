import { redirect } from 'next/navigation'
import { getExhibitorContext } from '@/lib/exhibitor'
import { CONTRACT_SECTIONS, CONTRACT_ACCEPTANCE_LINE, CONTRACT_DATE_RANGE, CONTRACT_VENUE } from '@/lib/contract/copy'
import { ContractSignPanel } from '@/components/exhibitor/ContractSignPanel'
import MiniTaskStrip from '@/components/exhibitor/MiniTaskStrip'

export const dynamic = 'force-dynamic'

// The first-login gate (PortalLayout) redirects approved-but-unsigned vendors
// here before they can use any other portal surface. Once they sign, the gate
// stamps contract_signed_at and they go to /exhibitor/portal.
export default async function ContractPage() {
  const ctx = await getExhibitorContext()
  if (!ctx) redirect('/exhibitor/login')

  const app = ctx.application as any
  const businessName = (app?.business_name as string) || ctx.email
  const contactName = (app?.contact_name as string) || ''
  const alreadySigned = Boolean(app?.contract_signed_at)

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      {/* 4-task mini progress strip. Same data as the Overview checklist. */}
      <MiniTaskStrip activeKey="contract" />

      {/* Header chrome, Cape Town Halaal + Young at Heart marks */}
      <header className="text-center mb-10">
        <h1 className="font-serif text-3xl text-[#1B1A17] tracking-tight">Vendor Contract 2026</h1>
        <p className="mt-2 text-sm text-neutral-600">
          {CONTRACT_DATE_RANGE}, {CONTRACT_VENUE}
        </p>
      </header>

      {/* Welcome banner if first time, gentle */}
      {!alreadySigned && (
        <div className="mb-6 rounded-xl bg-[#FDFAF1] border border-[#B8924A]/40 p-5">
          <p className="text-sm text-[#1B1A17]">
            Welcome aboard, <strong>{contactName.split(/\s+/)[0] || 'there'}</strong>. Before you can access the rest of
            the portal, please read this contract and sign at the bottom. You can save and download a copy for your
            records once you submit.
          </p>
        </div>
      )}

      {/* Wrong size? Signing locks the stall fee, so let an approved vendor change
          the stall size (or request a position) before they commit. Reachable
          here because the stall-request page gates on approval, not payment. */}
      {!alreadySigned && (
        <div className="mb-6 rounded-xl border border-[#cd2653]/20 bg-[#cd2653]/5 p-4 text-sm text-[#1B1A17]">
          Wrong stall size? You can change your stall size or request a different position{' '}
          <a href="/exhibitor/portal/stand/change" className="font-semibold text-[#cd2653] underline underline-offset-2">
            before you sign
          </a>
          . Signing locks your stall fee.
        </div>
      )}

      {/* Contract body */}
      <article className="bg-white rounded-2xl border border-neutral-200 p-8 space-y-7 text-[15px] leading-7 text-neutral-800">
        <p>
          This is a contract between <strong>Cape Town Halaal and Young at Heart Festival</strong> (referred to as
          &ldquo;we&rdquo; and &ldquo;the organisers&rdquo;) and the Stall Holder (referred to as the &ldquo;Vendor&rdquo;)
          for trading at the festival on <strong>{CONTRACT_DATE_RANGE}</strong> at {CONTRACT_VENUE}.
        </p>

        <div className="rounded-lg bg-neutral-50 border border-neutral-200 p-4 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-neutral-500">Vendor name</span>
            <span className="font-semibold text-[#1B1A17]">{businessName}</span>
          </div>
          {contactName && (
            <div className="flex items-baseline justify-between gap-3 mt-1">
              <span className="text-neutral-500">Contact</span>
              <span className="text-[#1B1A17]">{contactName}</span>
            </div>
          )}
        </div>

        {CONTRACT_SECTIONS.slice(1).map((sec, i) => (
          <section key={i}>
            {sec.heading && (
              <h2 className="font-serif text-lg text-[#1B1A17] mb-2 border-b border-neutral-200 pb-1">
                {sec.heading}
              </h2>
            )}
            {sec.intro && <p className="mb-2">{sec.intro}</p>}
            {sec.bullets && (
              <ul className="list-disc pl-6 space-y-2">
                {sec.bullets.map((b, j) => (
                  <li key={j}>{b}</li>
                ))}
              </ul>
            )}
          </section>
        ))}

        <p className="font-medium text-[#1B1A17] pt-4 border-t border-neutral-200">{CONTRACT_ACCEPTANCE_LINE}</p>
      </article>

      {/* Signature panel — client component, canvas + form */}
      <div className="mt-8">
        <ContractSignPanel
          alreadySigned={alreadySigned}
          signedAt={(app?.contract_signed_at as string | null) || null}
          signaturePath={(app?.contract_pdf_path as string | null) || null}
          fullName={contactName || businessName}
        />
      </div>
    </div>
  )
}
