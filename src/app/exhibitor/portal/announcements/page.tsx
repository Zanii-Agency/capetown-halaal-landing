import Image from 'next/image'
import { listAnnouncements } from '@/lib/announcements'
import { Megaphone, Pin } from 'lucide-react'
import { requirePaid } from '@/lib/exhibitor-paygate'
import {
  PageShell, PageHeader, Card, Empty
} from '@/components/chrome/PageChrome'

export const dynamic = 'force-dynamic'

function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 604800) return `${Math.floor(s / 86400)}d`
  return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })
}

export default async function AnnouncementsPage() {
  await requirePaid()
  const items = await listAnnouncements()

  return (
    <PageShell>
      <Card className={`max-w-xl mx-auto${items.length === 0 ? ' mb-8' : ''}`}>
        <PageHeader
          kicker="Announcements"
          title="Festival feed"
          subtitle="Updates from the organisers, newest first."
        />

        {items.length === 0 ? (
          <Empty
            title="No posts yet"
            hint="Festival updates will appear in your feed."
          />
        ) : (
          <div className="relative">
            {items.map((a, i) => (
              <div key={a.id} className="flex gap-3.5 relative pb-5">
                {/* timeline connector */}
                {i < items.length - 1 && <div className="absolute left-[19px] top-11 bottom-0 w-px bg-[#B8924A]/40" />}
                {/* avatar */}
                <div className="w-10 h-10 rounded-full bg-[#FDFAF1] border border-[#B8924A]/40 flex items-center justify-center shrink-0 z-10 ring-4 ring-[#F6F2E8]">
                  <Image src="/logo.png" alt="Young at Heart" width={28} height={28} className="object-contain" />
                </div>
                {/* post */}
                <div className={`flex-1 bg-[#FDFAF1] border rounded-2xl p-4 ${a.pinned ? 'border-[#cd2653]/30' : 'border-[#B8924A]/40'}`}>
                  <div className="flex items-center gap-1.5 text-sm flex-wrap">
                    <span className="font-semibold text-[#1B1A17]">Young at Heart</span>
                    <span className="text-[#1B1A17]/55">· Organisers · {timeAgo(a.created_at)}</span>
                    {a.pinned && <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#cd2653] ml-auto"><Pin className="w-3 h-3" /> Pinned</span>}
                  </div>
                  <p className="font-semibold text-[#1B1A17] mt-1.5">{a.title}</p>
                  <p className="text-sm text-[#1B1A17]/70 mt-1 whitespace-pre-wrap leading-relaxed">{a.body}</p>
                  <p className="text-xs text-[#1B1A17]/40 mt-3">{new Date(a.created_at).toLocaleString('en-ZA', { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </PageShell>
  )
}