'use client'

// Moved out of CustomerInboxClient 2026-07-26 so both panes share it. NeedsYou
// had been rendering a raw <img> and a 📎 emoji instead — the same attachment
// looked like two different things depending on which surface you opened.
//
// Images render inline through the same-origin admin media proxy; other kinds
// get a compact tappable chip. A row that predates media-id capture (url null)
// still shows an honest chip rather than the old literal "[media message]".
// `onDark` flips the chip skin so it stays legible on the magenta operator bubble.
import { FileText, Film, Image as ImageIcon, Mic, ExternalLink } from 'lucide-react'
import type { MediaInfo } from '@/lib/inbox/types'

export function MediaBubble({ media, onDark }: { media: MediaInfo; onDark?: boolean }) {
  const { kind, url, filename } = media
  if (kind === 'image' && url) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={filename || 'Image'} loading="lazy"
          className="rounded-lg max-h-72 max-w-full w-auto object-contain border border-neutral-200 bg-white" />
      </a>
    )
  }
  const Icon = kind === 'image' ? ImageIcon : kind === 'video' ? Film : kind === 'audio' ? Mic : FileText
  const label = filename || (kind === 'image' ? 'Image' : kind === 'video' ? 'Video' : kind === 'audio' ? 'Voice note' : 'Document')
  const chipCls = onDark
    ? 'bg-white/15 border-white/25 text-white hover:bg-white/25'
    : 'bg-neutral-50 border-neutral-200 text-neutral-700 hover:bg-neutral-100'
  const inner = (
    <span className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px] font-medium transition ${chipCls}`}>
      <Icon className="w-4 h-4 shrink-0" />
      <span className="truncate max-w-[220px]">{label}</span>
      {url && <ExternalLink className="w-3.5 h-3.5 shrink-0 opacity-60" />}
    </span>
  )
  return url
    ? <a href={url} target="_blank" rel="noreferrer">{inner}</a>
    : <span title="Original media is no longer retrievable" className="opacity-90">{inner}</span>
}
