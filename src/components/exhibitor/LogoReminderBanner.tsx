import Link from 'next/link'
import { ImageUp, ArrowRight } from 'lucide-react'

// Persistent logo-upload reminder shown on EVERY portal page for a vendor who
// has paid but has not uploaded a logo. Deliberately NOT dismissable: the parent
// layout only renders it while the logo is missing, so it disappears on its own
// the moment the vendor uploads one. No X, no "later" — it stays until done.
export function LogoReminderBanner({ firstName }: { firstName?: string }) {
  return (
    <div className="bg-gradient-to-r from-[#cd2653] to-[#7c1d3a] text-white border-b border-[#7c1d3a]/40">
      <div className="container mx-auto px-4 py-3 flex items-center gap-3">
        <div className="bg-white/20 rounded-full p-2 shrink-0">
          <ImageUp className="w-4 h-4" />
        </div>
        <p className="text-sm flex-1 min-w-0">
          <strong>Upload your logo{firstName ? `, ${firstName}` : ''}.</strong>{' '}
          <span className="text-white/85">
            Your stall is paid. Add your logo so you appear with your branding in the
            public festival listings. This reminder stays until your logo is up.
          </span>
        </p>
        <Link
          href="/exhibitor/portal/profile"
          className="shrink-0 inline-flex items-center gap-1.5 bg-white text-[#cd2653] rounded-lg px-3 py-1.5 text-xs font-semibold hover:bg-white/90"
        >
          Upload logo
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>
    </div>
  )
}

export default LogoReminderBanner
