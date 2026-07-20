import { Calendar, MapPin, Mail, FileCheck, Users, CreditCard, Download, ArrowRight, Megaphone, FileText } from 'lucide-react'
import {
  PageShell, PageHeader, Card
} from '@/components/chrome/PageChrome'

export const dynamic = 'force-dynamic'

const QUICK = [
  { href: '/exhibitor/portal/documents', label: 'Upload compliance documents', icon: FileCheck },
  { href: '/exhibitor/portal/staff', label: 'Register your gate staff', icon: Users },
  { href: '/exhibitor/portal/stand', label: 'Find your stand on the map', icon: MapPin },
  { href: '/exhibitor/portal/payments', label: 'Stall fee & payments', icon: CreditCard },
]

export default function ResourcesPage() {
  return (
    <PageShell>
      <PageHeader
        kicker="Resources"
        title="Everything you need to know"
      />

      <div className="space-y-6">
        {/* essentials */}
        <Card className="grid sm:grid-cols-2 gap-4 text-sm">
          <div className="flex items-start gap-3"><Calendar className="w-4 h-4 text-[#cd2653] mt-0.5" /><div><p className="font-medium text-[#1B1A17]">11 – 13 December 2026</p><p className="text-[#1B1A17]/55 text-xs">Three-day festival</p></div></div>
          <div className="flex items-start gap-3"><MapPin className="w-4 h-4 text-[#cd2653] mt-0.5" /><div><p className="font-medium text-[#1B1A17]">Youngsfield Military Base</p><p className="text-[#1B1A17]/55 text-xs">Wetton Road, Cape Town</p></div></div>
          <div className="flex items-start gap-3"><Mail className="w-4 h-4 text-[#cd2653] mt-0.5" /><div><p className="font-medium text-[#1B1A17]">support@youngatheart.co.za</p><p className="text-[#1B1A17]/55 text-xs">Organiser support</p></div></div>
          <div className="flex items-start gap-3"><Megaphone className="w-4 h-4 text-[#cd2653] mt-0.5" /><div><p className="font-medium text-[#1B1A17]">Load-in: Thursday 10 Dec</p><p className="text-[#1B1A17]/55 text-xs">4pm – 9pm setup only</p></div></div>
        </Card>

        {/* Load-in Schedule */}
        <Card>
          <p className="font-semibold text-[#1B1A17] mb-4 flex items-center gap-2">
            <Calendar className="w-5 h-5 text-[#cd2653]" />
            Load-in Schedule
          </p>
          <div className="space-y-4 text-sm">
            <div className="p-4 bg-[#cd2653]/5 border border-[#cd2653]/20 rounded-lg">
              <p className="font-medium text-[#1B1A17] mb-2">Thursday 10 December: Setup Day</p>
              <ul className="space-y-1.5 text-[#1B1A17]/70">
                <li className="flex items-start gap-2">
                  <span className="text-[#cd2653] font-bold">•</span>
                  <span><strong>4pm – 9pm:</strong> All vendors must set up during this window only</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[#cd2653] font-bold">•</span>
                  <span><strong>Food trucks:</strong> Must come and park directly in your allocated space</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[#cd2653] font-bold">•</span>
                  <span><strong>No offloading on Friday.</strong> Everything must be completed on Thursday</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[#cd2653] font-bold">•</span>
                  <span>Bring all equipment, stock, and signage on Thursday</span>
                </li>
              </ul>
            </div>
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
              <p className="font-medium text-amber-900 mb-1">Important</p>
              <p className="text-amber-800 text-xs">If you cannot make the Thursday setup window, contact support@youngatheart.co.za immediately. No exceptions for Friday setup.</p>
            </div>
          </div>
        </Card>

        {/* quick actions */}
        <Card>
          <p className="font-semibold text-[#1B1A17] mb-4">Get show-ready</p>
          <div className="grid sm:grid-cols-2 gap-2">
            {QUICK.map((q) => (
              <a key={q.href} href={q.href} className="flex items-center justify-between p-3 rounded-lg border border-[#B8924A]/40 hover:border-[#cd2653] group">
                <span className="flex items-center gap-2 text-sm text-[#1B1A17]/70"><q.icon className="w-4 h-4 text-[#cd2653]" />{q.label}</span>
                <ArrowRight className="w-4 h-4 text-[#1B1A17]/20 group-hover:text-[#cd2653]" />
              </a>
            ))}
          </div>
        </Card>

        {/* downloads */}
        <section>
          <h2 className="font-serif text-xl mb-4">Downloads</h2>
          <p className="text-sm text-[#1B1A17]/55 mb-4">
            These resource packs are being finalised and will be shared here closer to setup. We will email every confirmed vendor the moment they are ready.
          </p>
          <div className="grid gap-3">
            {[
              { label: 'Vendor Manual' },
              { label: 'Load-in Schedule' },
              { label: 'Setup Checklist' },
              { label: 'Site Map' },
            ].map(item => (
              <div key={item.label}
                className="flex items-center gap-3 p-4 rounded-xl border border-[#E5DCC4] bg-[#FAF7F0]">
                <FileText className="w-5 h-5 text-neutral-300" />
                <span className="text-sm font-medium text-[#1B1A17]/50">{item.label}</span>
                <span className="ml-auto text-xs font-medium text-[#1B1A17]/40 bg-white border border-[#E5DCC4] rounded-full px-2.5 py-1">
                  Available closer to the festival
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* contacts */}
        <section>
          <h2 className="font-serif text-xl mb-4">Important Contacts</h2>
          <Card>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-neutral-500">Operations</dt>
                <dd className="font-medium">+27 65 943 5012</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-neutral-500">Support</dt>
                <dd className="font-medium">support@youngatheart.co.za</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-neutral-500">Emergency (show-day)</dt>
                <dd className="font-medium">+27 65 943 5012</dd>
              </div>
            </dl>
          </Card>
        </section>

        {/* brand assets */}
        <Card>
          <p className="font-semibold text-[#1B1A17] mb-1">Brand assets</p>
          <p className="text-xs text-[#1B1A17]/55 mb-4">Use the festival logo when you promote your stall.</p>
          <a href="/logo.png" download className="inline-flex items-center gap-2 text-sm font-medium rounded-lg px-3 py-2 border border-[#B8924A]/40 hover:border-[#cd2653] hover:text-[#cd2653]">
            <Download className="w-4 h-4" /> Festival logo (PNG)
          </a>
        </Card>
      </div>
    </PageShell>
  )
}
