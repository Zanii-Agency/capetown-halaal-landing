'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useSearchParams } from 'next/navigation'
import { AdminPage } from '@/components/admin/AdminPage'
import {
  Loader2, Mail, MessageCircle, Search, Send, ChevronDown, Star, MailOpen,
  MoreHorizontal, Check, Clock, RotateCcw, Sparkles, Wand2, MessageSquarePlus,
  FileText, Paperclip, ListChecks, X, ExternalLink, Bot, UserCheck, Tag as TagIcon, StickyNote,
  IdCard, CreditCard, MapPin, FileCheck, ImageIcon, Film, Mic,
  Bell, Maximize2, Minimize2, ChevronLeft, ChevronRight,
} from 'lucide-react'

type Tab = 'all' | 'mine' | 'open' | 'snoozed' | 'resolved' | 'unread' | 'needs'
type Channel = 'all' | 'whatsapp' | 'email'
const INBOX_TAGS = ['payment', 'load-in', 'badges', 'contract', 'refund', 'general'] as const
type InboxTag = (typeof INBOX_TAGS)[number]

interface Contact {
  id: string
  business_name: string | null
  contact_name: string | null
  phone: string | null
  email: string | null
  channels: Array<'whatsapp' | 'email'>
  identity: 'vendor' | 'ticket_buyer' | 'unknown'
  last_message_at: string | null
  last_preview: string | null
  last_direction: 'in' | 'out' | null
  unread: boolean
  starred: boolean
  tag: string | null
  assignee_id: string | null
  application_id: string | null
  status: string
  bot_paused: boolean
  needs_response: boolean
}

interface MediaInfo {
  kind: 'image' | 'document' | 'video' | 'audio' | 'sticker'
  url: string | null
  mimeType?: string
  filename?: string
}
interface CommItem {
  id: string
  channel: 'whatsapp' | 'email'
  direction: 'in' | 'out'
  bot?: boolean
  body: string
  at: string
  from: string
  subject?: string
  // An array: WhatsApp is always 0 or 1, a real email can carry several
  // attachments at once.
  media?: MediaInfo[]
  pending?: boolean   // optimistic outbound, not yet confirmed by the server
}

interface Operator { id: string; email: string }

type AiAction = 'smart_reply' | 'tone_adjust' | 'follow_up' | 'summarize' | 'attachments' | 'status_update'
// Full catalogue kept so runAI()/AI_CARDS.find() label lookups stay intact for
// every endpoint action (Smart Reply via the composer sparkle, Summarize via the
// More menu). No always-visible AI pill row: it duplicated the composer sparkle.
const AI_CARDS: Array<{ action: AiAction; label: string; short: string; icon: typeof Sparkles }> = [
  { action: 'smart_reply', label: 'Smart Reply', short: 'Reply', icon: MessageSquarePlus },
  { action: 'tone_adjust', label: 'Tone Adjustment', short: 'Tone', icon: Wand2 },
  { action: 'follow_up', label: 'Follow-Up Suggestions', short: 'Follow-up', icon: Sparkles },
  { action: 'summarize', label: 'Message Summarization', short: 'Summary', icon: FileText },
  { action: 'attachments', label: 'Suggested Attachments', short: 'Links', icon: Paperclip },
  { action: 'status_update', label: 'Automated Status Updates', short: 'Status', icon: ListChecks },
]

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// SAST = Africa/Johannesburg (UTC+2, no DST). The operator wants the real
// time-of-occurrence in SA local time, not relative "10h ago" strings. We pin
// the timeZone on every formatter so it reads the same regardless of where the
// server or the operator's browser sits.
const SA_TZ = 'Africa/Johannesburg'
const saParts = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  // en-GB + the SA tz gives 24h HH:mm and a day/month/year we can read back.
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: SA_TZ, year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d)
  const get = (t: string) => p.find((x) => x.type === t)?.value || ''
  return { day: get('day'), month: get('month'), year: get('year'), hour: get('hour'), minute: get('minute') }
}
// Bubble timestamp: always the real SAST clock time, e.g. "14:32".
function fmtTime(iso: string): string {
  const p = saParts(iso)
  return p ? `${p.hour}:${p.minute}` : ''
}
// Date separators, in SAST. Today / Yesterday relative to SA local day.
function fmtDay(iso: string): string {
  const p = saParts(iso)
  if (!p) return ''
  const todayP = saParts(new Date().toISOString())
  const yP = saParts(new Date(Date.now() - 86_400_000).toISOString())
  const same = (a: typeof p, b: typeof p | null) => !!b && a.day === b.day && a.month === b.month && a.year === b.year
  if (same(p, todayP)) return 'Today'
  if (same(p, yP)) return 'Yesterday'
  return `${p.day} ${p.month} ${p.year}`
}
// Conversation-list time + notes: the real SAST time of occurrence, compact.
// "14:32" when it happened today (SA), else "21 Jun 14:32".
function fmtSAST(iso: string | null): string {
  if (!iso) return ''
  const p = saParts(iso)
  if (!p) return ''
  const todayP = saParts(new Date().toISOString())
  const isToday = !!todayP && p.day === todayP.day && p.month === todayP.month && p.year === todayP.year
  return isToday ? `${p.hour}:${p.minute}` : `${p.day} ${p.month} ${p.hour}:${p.minute}`
}
function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean)
  if (!p.length) return '?'
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase()
  return (p[0][0] + p[p.length - 1][0]).toUpperCase()
}
function statusChip(s: string): { label: string; cls: string } {
  if (s === 'resolved') return { label: 'Resolved', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
  if (s === 'snoozed') return { label: 'Snoozed', cls: 'bg-amber-50 text-amber-700 border-amber-200' }
  return { label: 'Open', cls: 'bg-sky-50 text-sky-700 border-sky-200' }
}
function tagCls(t: string): string {
  switch (t) {
    case 'payment': return 'bg-green-50 text-green-700 border-green-200'
    case 'load-in': return 'bg-indigo-50 text-indigo-700 border-indigo-200'
    case 'badges': return 'bg-purple-50 text-purple-700 border-purple-200'
    case 'contract': return 'bg-orange-50 text-orange-700 border-orange-200'
    case 'refund': return 'bg-red-50 text-red-700 border-red-200'
    default: return 'bg-neutral-100 text-neutral-600 border-neutral-200'
  }
}

// Render an incoming/outgoing media attachment. Images render inline via the
// same-origin admin media proxy; other kinds get a compact tappable chip. When
// the row predates media-id capture (url === null) we still show an honest chip
// instead of the old literal "[media message]" text. `onDark` flips the chip
// skin so it stays legible on the magenta operator bubble.
function MediaBubble({ media, onDark }: { media: MediaInfo; onDark?: boolean }) {
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

interface CannedReply { slug: string; label: string; subject: string | null; body: string }
interface Note { at: string; by: string; text: string }
interface VendorContext {
  status: string; tier: string | null; sector: string | null
  payment: { status: string; amount: number | null; paid_at: string | null }
  stall: string | null; docs_complete: boolean; contract_signed: boolean
}

export function CustomerInboxClient({ currentUserId, operators, eftOnly }: { currentUserId: string; operators: Operator[]; eftOnly?: boolean }) {
  // TEMPORARY EFT lane: when mounted on /admin/eft this appends &eftOnly=1 to the
  // contact-list fetches, so the same inbox shows ONLY EFT-lane conversations.
  const eftParam = eftOnly ? '&eftOnly=1' : ''
  const [tab, setTab] = useState<Tab>('all')
  const [tagFilter, setTagFilter] = useState<InboxTag | null>(null)
  const [channel, setChannel] = useState<Channel>('all')
  const [contacts, setContacts] = useState<Contact[]>([])
  const [counts, setCounts] = useState<{ all: number; whatsapp: number; email: number; unread: number; needs_response: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [focusMode, setFocusMode] = useState(false)
  const [messages, setMessages] = useState<CommItem[]>([])
  const [msgsLoading, setMsgsLoading] = useState(false)
  const [reply, setReply] = useState('')
  const [replyChannel, setReplyChannel] = useState<'whatsapp' | 'email'>('whatsapp')
  const [sending, setSending] = useState(false)
  const [sendMsg, setSendMsg] = useState<string | null>(null)
  const [aiBusy, setAiBusy] = useState<AiAction | null>(null)
  const [aiResult, setAiResult] = useState<{ title: string; text: string } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [windowClosed, setWindowClosed] = useState(false)
  const [handoverBusy, setHandoverBusy] = useState(false)
  const [canned, setCanned] = useState<CannedReply[]>([])
  const [cannedOpen, setCannedOpen] = useState(false)
  const [tagOpen, setTagOpen] = useState(false)
  const [notes, setNotes] = useState<Note[]>([])
  const [noteText, setNoteText] = useState('')
  const [notesOpen, setNotesOpen] = useState(false)
  const [attachment, setAttachment] = useState<{ filename: string; contentType: string; dataBase64: string } | null>(null)
  const [ctx, setCtx] = useState<VendorContext | null>(null)
  const [ctxOpen, setCtxOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const prevSearch = useRef('')
  const autoOpened = useRef(false)

  // Deep-link: another page (e.g. the vendor profile "Send WhatsApp" / "Send
  // Email" buttons) can hand us ?contact=<E.164-or-email>&channel=<whatsapp|email>
  // so the operator lands straight on that vendor's thread with the composer
  // ready. We read it once, set the channel, then auto-select the matching
  // contact after the list has loaded. didDeepLink guards against re-firing on
  // every 15s poll (which would yank the operator back off a manual selection).
  const searchParams = useSearchParams()
  const deepLinkContact = searchParams.get('contact')
  const deepLinkChannel = searchParams.get('channel')
  const deepLinkView = searchParams.get('view')
  const didDeepLink = useRef(false)

  // Entered from the sidebar "Needs You" nav item (/admin/customer-inbox?view=needs):
  // open straight into the action queue across all channels. Tracks the param so
  // toggling Inbox <-> Needs You in the sidebar flips the view without a remount.
  useEffect(() => {
    if (deepLinkView === 'needs') { setChannel('all'); setTab('needs') }
    else if (deepLinkView === null) { setTab((t) => (t === 'needs' ? 'all' : t)); setFocusMode(false) }
  }, [deepLinkView])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/inbox/unified?channel=${channel}${eftParam}`)
      const j = await res.json()
      if (res.ok) { setContacts(j.contacts || []); setCounts(j.counts || null) }
    } finally { setLoading(false) }
  }, [channel, eftParam])

  useEffect(() => { load() }, [load])

  // Server-side search: when there's a query, fetch the whole base (matched
  // vendors beyond the recency cap); when cleared, restore the recency list.
  useEffect(() => {
    const term = search.trim()
    if (!term) { if (prevSearch.current) load(); prevSearch.current = ''; return }
    prevSearch.current = term
    const t = setTimeout(() => {
      fetch(`/api/admin/inbox/unified?channel=${channel}&q=${encodeURIComponent(term)}${eftParam}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (j) { setContacts(j.contacts || []); setCounts(j.counts || null) } })
        .catch(() => { /* keep last */ })
    }, 350)
    return () => clearTimeout(t)
  }, [search, channel, load])

  // Canned replies (reused from the support inbox) — load once.
  useEffect(() => {
    fetch('/api/admin/support-inbox/canned')
      .then((r) => (r.ok ? r.json() : { replies: [] }))
      .then((j) => setCanned(j.replies || []))
      .catch(() => { /* optional */ })
  }, [])

  // Silent refreshers for polling (no spinners, no state resets).
  const loadSilent = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/inbox/unified?channel=${channel}${eftParam}`)
      const j = await res.json()
      if (res.ok) { setContacts(j.contacts || []); setCounts(j.counts || null) }
    } catch { /* keep last good */ }
  }, [channel, eftParam])

  const refreshMessages = useCallback(async (c: Contact) => {
    try {
      const params = new URLSearchParams()
      if (c.phone) params.set('phone', c.phone)
      if (c.email) params.set('email', c.email)
      const res = await fetch(`/api/admin/inbox/unified/messages?${params}`)
      const j = await res.json()
      if (res.ok) setMessages((prev) => {
        const next: CommItem[] = j.messages || []
        return next.length !== prev.length ? next : prev
      })
    } catch { /* keep last good */ }
  }, [])

  // Refs so the poll interval reads current state without resetting itself.
  const activeIdRef = useRef<string | null>(null); activeIdRef.current = activeId
  const contactsRef = useRef<Contact[]>([]); contactsRef.current = contacts

  // LIVE: Supabase Realtime. The webhook fires a content-free "refresh" broadcast
  // the instant a message lands (or the bot replies), and we re-fetch through the
  // server route immediately. This is what makes the inbox feel native, no waiting
  // for the next poll. (No PII in the broadcast; the data comes from the route.)
  const refreshNow = useCallback(() => {
    if (document.hidden) return
    loadSilent()
    const c = contactsRef.current.find((x) => x.id === activeIdRef.current)
    if (c) refreshMessages(c)
  }, [loadSilent, refreshMessages])

  useEffect(() => {
    const supabase = createClient()
    const ch = supabase
      .channel('inbox-updates')
      .on('broadcast', { event: 'refresh' }, () => refreshNow())
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [refreshNow])

  // Fallback poll (safety net if the realtime socket drops). Slow now that
  // realtime carries the live updates.
  useEffect(() => {
    const id = setInterval(() => refreshNow(), 30000)
    return () => clearInterval(id)
  }, [refreshNow])

  const active = useMemo(() => contacts.find((c) => c.id === activeId) || null, [contacts, activeId])
  const nameOf = (c: Contact) => c.business_name || c.contact_name || c.phone || c.email || 'Unknown'

  const filtered = useMemo(() => {
    let list = contacts
    if (tab === 'unread') list = list.filter((c) => c.unread)
    else if (tab === 'needs') list = list.filter((c) => c.needs_response)
    else if (tab === 'mine') list = list.filter((c) => c.assignee_id === currentUserId)
    else if (tab !== 'all') list = list.filter((c) => c.status === tab)
    if (tagFilter) list = list.filter((c) => c.tag === tagFilter)
    const q = search.trim().toLowerCase()
    if (q) list = list.filter((c) =>
      nameOf(c).toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q) || (c.phone || '').includes(q))
    return list
  }, [contacts, tab, search, tagFilter, currentUserId])

  // Needs-You: keep a waiting conversation open. On entering the tab (or when the
  // open one is answered/resolved and drops out of the list), snap to the first
  // still-waiting item so she never lands on an empty pane with work left.
  useEffect(() => {
    if (tab !== 'needs') return
    const stillOpen = activeId && filtered.some((c) => c.id === activeId)
    if (!stillOpen) setActiveId(filtered.length ? filtered[0].id : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, contacts])

  const loadMessages = useCallback(async (c: Contact) => {
    setMsgsLoading(true)
    try {
      const params = new URLSearchParams()
      if (c.phone) params.set('phone', c.phone)
      if (c.email) params.set('email', c.email)
      const res = await fetch(`/api/admin/inbox/unified/messages?${params}`)
      const j = await res.json()
      if (res.ok) {
        setMessages(j.messages || [])
        // Force-scroll to the bottom for a freshly OPENED thread, imperatively,
        // not via the [messages, activeId] effect below (Taona 2026-07-12,
        // "opens at the top instead of the bottom"). That effect fires on
        // React's render tick, which can land BEFORE the browser has actually
        // painted the new message list, so el.scrollHeight still reports the
        // PREVIOUS (shorter/taller) thread's height — the scroll assignment
        // lands on stale geometry and visually settles wherever the browser's
        // default (top) leaves it. Two nested rAFs: the first waits for this
        // commit to be painted, the second waits for layout from THAT paint to
        // be final (fonts/wrapping can still shift height across a single
        // frame) — one rAF alone still raced on real thread data in testing.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const el = scrollRef.current
            if (el) el.scrollTop = el.scrollHeight
          })
        })
      }
    } finally { setMsgsLoading(false) }
  }, [])

  // Mark a contact read (optimistic + persist) when its conversation opens.
  const markRead = useCallback(async (c: Contact) => {
    if (!c.unread) return
    setContacts((prev) => prev.map((x) => (x.id === c.id ? { ...x, unread: false } : x)))
    setCounts((p) => (p ? { ...p, unread: Math.max(0, p.unread - 1) } : p))
    try {
      await fetch('/api/admin/inbox/unified/status', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'read', applicationId: c.application_id || undefined, phone: c.phone || undefined, email: c.email || undefined }),
      })
    } catch { /* best effort */ }
  }, [])

  // Deep-link handler. Runs once, after the contacts list has loaded, when a
  // ?contact= param is present. Sets the channel from ?channel=, then finds the
  // contact whose phone matches (compared digits-only, tolerant of +, leading 0
  // and the 27 country code) or whose email matches (case-insensitive), and
  // selects it through the SAME setActiveId a click uses. No match (vendor never
  // messaged): we just set the channel and pre-fill the search box so the
  // operator sees there is no thread yet. Either way we mark autoOpened so the
  // "open most recent" fallback below does not override the deep-link.
  useEffect(() => {
    if (didDeepLink.current) return
    if (!deepLinkContact) return
    if (loading) return // wait until the first contacts load resolves
    didDeepLink.current = true

    if (deepLinkChannel === 'whatsapp' || deepLinkChannel === 'email') {
      setChannel(deepLinkChannel)
    }

    const digits = (v: string | null | undefined) => (v || '').replace(/\D/g, '')
    const target = deepLinkContact.trim()
    const targetDigits = digits(target)
    const targetEmail = target.toLowerCase()
    const isEmailTarget = target.includes('@')

    // Phone match: compare digits-only and tolerate the common ZA variants:
    // exact, with/without leading + (already stripped by digits()), a leading 0
    // local form (0727...) vs the 27 country-code form (27727...).
    const phoneMatches = (cd: string) => {
      if (!cd || !targetDigits) return false
      if (cd === targetDigits) return true
      const norm = (d: string) => {
        if (d.startsWith('27')) return d.slice(2)
        if (d.startsWith('0')) return d.slice(1)
        return d
      }
      return norm(cd) === norm(targetDigits)
    }

    const match = contacts.find((c) => {
      if (isEmailTarget) return (c.email || '').toLowerCase() === targetEmail
      return phoneMatches(digits(c.phone)) || (!!c.email && c.email.toLowerCase() === targetEmail)
    })

    // Block the "open most recent" fallback from firing regardless of outcome.
    autoOpened.current = true

    if (match) {
      setActiveId(match.id)
    } else {
      // No thread yet: surface the contact value in the search box so the
      // operator can see there is nothing to open for this vendor.
      setSearch(target)
    }
  }, [deepLinkContact, deepLinkChannel, loading, contacts])

  // Open the most recent conversation automatically so the inbox "opens well".
  useEffect(() => {
    if (!autoOpened.current && !loading && filtered.length > 0 && !activeId) {
      autoOpened.current = true
      setActiveId(filtered[0].id)
    }
  }, [loading, filtered, activeId])

  // Run ONLY when the opened conversation changes (keyed on the stable id, not
  // the derived `active` object). Keying on `active` would re-fire this on every
  // optimistic contacts update (star/resolve/snooze/mark-read), reloading the
  // thread and wiping the AI result strip mid-read. So depend on activeId alone.
  useEffect(() => {
    const c = contacts.find((x) => x.id === activeId)
    if (!c) return
    loadMessages(c)
    setReplyChannel(c.phone ? 'whatsapp' : 'email')
    setSendMsg(null); setAiResult(null); setMenuOpen(false); setWindowClosed(false)
    setCannedOpen(false); setTagOpen(false); setNotesOpen(false); setNoteText(''); setNotes([])
    setAttachment(null); setCtx(null); setCtxOpen(false)
    if (c.application_id) {
      fetch(`/api/admin/inbox/unified/notes?applicationId=${c.application_id}`)
        .then((r) => (r.ok ? r.json() : { notes: [] }))
        .then((j) => setNotes(j.notes || []))
        .catch(() => { /* optional */ })
      fetch(`/api/admin/inbox/unified/context?applicationId=${c.application_id}`)
        .then((r) => (r.ok ? r.json() : { context: null }))
        .then((j) => setCtx(j.context || null))
        .catch(() => { /* optional */ })
    }
    markRead(c)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  // Follow new messages during BACKGROUND POLLING only if the operator is
  // already near the bottom — if they scrolled up to read older messages, a
  // poll must NOT yank them back down. The "thread just opened, force to
  // bottom" case is handled imperatively in loadMessages (double-rAF, right
  // where the fetch resolves) — see that comment for why a reactive effect
  // keyed on [messages, activeId] cannot reliably do it (Taona 2026-07-12,
  // "opens at the top instead of the bottom"): activeId changes on its own
  // render tick before the new messages exist, so any version of this effect
  // fires at least once against stale geometry. No cross-thread race applies
  // here since activeId is unchanged during a poll, so scrollHeight always
  // reflects the SAME thread's real, current content.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [messages])

  // Auto-grow the composer with its content, up to ~8 lines, so a multi-line
  // reply is fully visible without scrolling inside a tiny box.
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 192)}px`
  }, [reply, activeId])

  const onPickFile = useCallback((file: File | null) => {
    if (!file) return
    if (file.size > 4_500_000) { setSendMsg('File too large (max ~4.5MB).'); return }
    const reader = new FileReader()
    reader.onload = () => {
      const res = String(reader.result || '')
      const base64 = res.includes(',') ? res.split(',')[1] : res
      setAttachment({ filename: file.name, contentType: file.type || 'application/octet-stream', dataBase64: base64 })
    }
    reader.readAsDataURL(file)
  }, [])

  // In Focus mode, after a conversation is handled (replied or resolved), jump
  // to the NEXT still-waiting one so she clears the stack without leaving the
  // screen. The just-handled id is excluded because local state hasn't refetched
  // its (now-false) needs_response yet.
  const advanceNeeds = useCallback((handledId: string) => {
    if (!focusMode || tab !== 'needs') return
    const order = contacts.filter((c) => c.needs_response && c.status !== 'resolved')
    const idx = order.findIndex((c) => c.id === handledId)
    const next = order.slice(idx + 1).find((c) => c.id !== handledId)
      || order.find((c) => c.id !== handledId)
      || null
    setActiveId(next ? next.id : null)
  }, [focusMode, tab, contacts])

  const submitReply = useCallback(async () => {
    if (!active || (!reply.trim() && !attachment)) return
    const text = reply.trim()
    const hadAttachment = !!attachment
    // OPTIMISTIC: show the reply immediately + clear the box, like WhatsApp. The
    // server reload reconciles it (replaces the temp with the real row).
    const tempId = `temp:${Date.now()}`
    if (text) {
      setMessages((prev) => [...prev, {
        id: tempId, channel: replyChannel, direction: 'out', body: text,
        at: new Date().toISOString(), from: 'You', pending: true,
      }])
    }
    setReply(''); setAttachment(null)
    setSending(true); setSendMsg(null)
    try {
      const res = await fetch('/api/admin/inbox/unified/reply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: replyChannel,
          phone: replyChannel === 'whatsapp' ? active.phone : undefined,
          email: replyChannel === 'email' ? active.email : undefined,
          text: text || undefined,
          attachment: hadAttachment ? attachment : undefined,
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || j.ok === false) {
        // Roll back the optimistic bubble + restore the text so she can retry.
        setMessages((prev) => prev.filter((m) => m.id !== tempId))
        if (text) setReply(text)
        setSendMsg(j.message || j.error || 'Send failed.')
        if (j.windowClosed) setWindowClosed(true)
        return
      }
      setWindowClosed(false)
      await loadMessages(active)
      advanceNeeds(active.id)
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== tempId))
      if (text) setReply(text)
      setSendMsg('Send failed.')
    } finally { setSending(false) }
  }, [active, reply, replyChannel, attachment, loadMessages, advanceNeeds])

  // Outside the 24h window: send the same text as an approved announcement template.
  const sendAsTemplate = useCallback(async () => {
    if (!active?.phone || !reply.trim()) return
    setSending(true); setSendMsg(null)
    try {
      const res = await fetch('/api/admin/inbox/unified/reply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'whatsapp', mode: 'template', phone: active.phone, text: reply.trim() }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || j.ok === false) { setSendMsg(j.message || j.error || 'Template send failed.'); return }
      setReply(''); setWindowClosed(false); await loadMessages(active)
    } catch { setSendMsg('Template send failed.') } finally { setSending(false) }
  }, [active, reply, loadMessages])

  // Take the conversation off the auto-bot (human handling) or hand it back.
  const toggleHandover = useCallback(async () => {
    if (!active?.phone || handoverBusy) return
    const taking = !active.bot_paused
    setHandoverBusy(true)
    setContacts((prev) => prev.map((c) => (c.id === active.id ? { ...c, bot_paused: taking } : c)))
    try {
      await fetch('/api/admin/inbox/unified/handover', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: active.phone, action: taking ? 'take_over' : 'hand_back' }),
      })
    } catch { /* optimistic */ } finally { setHandoverBusy(false) }
  }, [active, handoverBusy])

  const runAI = useCallback(async (action: AiAction) => {
    if (!active || aiBusy) return
    setAiBusy(action); setAiResult(null); setSendMsg(null)
    try {
      const res = await fetch('/api/admin/inbox/unified/ai', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, phone: active.phone || undefined, email: active.email || undefined, draft: reply.trim() || undefined }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || j.ok === false) { setSendMsg(j.message || j.error || 'AI could not run.'); return }
      if (j.fillsComposer) setReply(j.text)
      else setAiResult({ title: AI_CARDS.find((c) => c.action === action)?.label || 'AI', text: j.text })
    } catch { setSendMsg('AI could not run.') } finally { setAiBusy(null) }
  }, [active, aiBusy, reply])

  const doStatus = useCallback(async (
    action: 'resolve' | 'snooze' | 'reopen' | 'star' | 'unstar' | 'unread' | 'assign' | 'tag' | 'untag',
    extra?: { assigneeId?: string | null; tag?: InboxTag },
  ) => {
    if (!active) return
    setMenuOpen(false); setTagOpen(false)
    setContacts((prev) => prev.map((c) => {
      if (c.id !== active.id) return c
      if (action === 'resolve') return { ...c, status: 'resolved' }
      if (action === 'snooze') return { ...c, status: 'snoozed' }
      if (action === 'reopen') return { ...c, status: 'open' }
      if (action === 'star') return { ...c, starred: true }
      if (action === 'unstar') return { ...c, starred: false }
      if (action === 'unread') return { ...c, unread: true }
      if (action === 'assign') return { ...c, assignee_id: extra?.assigneeId ?? null }
      if (action === 'tag') return { ...c, tag: extra?.tag ?? null }
      if (action === 'untag') return { ...c, tag: null }
      return c
    }))
    if (action === 'resolve') advanceNeeds(active.id)
    try {
      await fetch('/api/admin/inbox/unified/status', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, applicationId: active.application_id || undefined, phone: active.phone || undefined, email: active.email || undefined, assigneeId: extra?.assigneeId, tag: extra?.tag }),
      })
    } catch { /* optimistic */ }
  }, [active, advanceNeeds])

  const addNote = useCallback(async () => {
    if (!active?.application_id || !noteText.trim()) return
    const text = noteText.trim()
    setNoteText('')
    try {
      const res = await fetch('/api/admin/inbox/unified/notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationId: active.application_id, text }),
      })
      const j = await res.json().catch(() => ({}))
      if (j.notes) setNotes(j.notes)
    } catch { /* keep draft cleared, refetch on reopen */ }
  }, [active, noteText])

  // Group messages by day for date separators.
  const grouped = useMemo(() => {
    const out: Array<{ day: string; items: CommItem[] }> = []
    for (const m of messages) {
      const day = fmtDay(m.at)
      const last = out[out.length - 1]
      if (last && last.day === day) last.items.push(m)
      else out.push({ day, items: [m] })
    }
    return out
  }, [messages])

  const assigneeEmail = (id: string | null) => operators.find((o) => o.id === id)?.email || null

  // Needs-You queue position for the Focus-mode carousel (prev / "3 of 7" / next).
  const inNeeds = tab === 'needs'
  const needsPos = inNeeds && active ? filtered.findIndex((c) => c.id === active.id) : -1
  const needsPrev = needsPos > 0 ? filtered[needsPos - 1] : null
  const needsNext = needsPos >= 0 && needsPos < filtered.length - 1 ? filtered[needsPos + 1] : null
  const focus = focusMode && inNeeds

  return (
    <AdminPage fill title="Inbox" caption="UNIFIED" subtitle="Every WhatsApp, bot and email conversation in one place.">
      <div className={`grid ${focus ? 'grid-cols-1' : 'lg:grid-cols-[1fr_380px]'} grid-rows-[minmax(0,1fr)] h-[calc(100dvh-6rem)] lg:h-full gap-4`}>

        {/* LEFT: conversation */}
        <div className="flex flex-col min-h-0 border border-neutral-200 rounded-2xl overflow-hidden bg-white">
          {/* Needs-You strip: the queue's home base. In split it carries the
              Focus toggle + counter; in Focus mode it adds the prev/next
              carousel controls so she clears the stack without leaving. */}
          {inNeeds && (
            <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-rose-100 bg-rose-50/70 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <Bell className="w-4 h-4 text-[#cd2653] shrink-0" />
                <span className="text-xs font-bold text-[#cd2653]">Needs You</span>
                {filtered.length > 0 && (
                  <span className="text-[11px] font-semibold text-rose-700/80 whitespace-nowrap">
                    {needsPos >= 0 ? `${needsPos + 1} of ${filtered.length}` : `${filtered.length}`} waiting
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {focus && (
                  <>
                    <button onClick={() => needsPrev && setActiveId(needsPrev.id)} disabled={!needsPrev}
                      title="Previous" className="w-7 h-7 rounded-lg border border-rose-200 bg-white hover:bg-rose-100 flex items-center justify-center disabled:opacity-40">
                      <ChevronLeft className="w-4 h-4 text-[#cd2653]" />
                    </button>
                    <button onClick={() => needsNext && setActiveId(needsNext.id)} disabled={!needsNext}
                      title="Next" className="w-7 h-7 rounded-lg border border-rose-200 bg-white hover:bg-rose-100 flex items-center justify-center disabled:opacity-40">
                      <ChevronRight className="w-4 h-4 text-[#cd2653]" />
                    </button>
                  </>
                )}
                <button onClick={() => setFocusMode((v) => !v)}
                  title={focus ? 'Exit focus (show the list)' : 'Focus mode (clear them one by one)'}
                  className="h-7 px-2 rounded-lg border border-rose-200 bg-white hover:bg-rose-100 flex items-center gap-1 text-[11px] font-semibold text-[#cd2653]">
                  {focus ? <><Minimize2 className="w-3.5 h-3.5" />Exit focus</> : <><Maximize2 className="w-3.5 h-3.5" />Focus</>}
                </button>
              </div>
            </div>
          )}
          {!active ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
              <MessageCircle className="w-8 h-8 text-neutral-300 mb-3" />
              <p className="text-sm text-neutral-400">Select a conversation from the list.</p>
            </div>
          ) : (
            <>
              {/* Header */}
              <div className="flex items-start justify-between gap-3 px-5 py-3 border-b border-neutral-100">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="relative shrink-0">
                    <div className="w-11 h-11 rounded-full bg-[#cd2653]/10 text-[#cd2653] flex items-center justify-center text-sm font-bold">{initials(nameOf(active))}</div>
                    <span className="absolute -bottom-0.5 -right-0.5 flex gap-0.5">
                      {active.channels.includes('whatsapp') && <MessageCircle className="w-3.5 h-3.5 text-emerald-600 bg-white rounded-full" />}
                      {active.channels.includes('email') && <Mail className="w-3.5 h-3.5 text-blue-600 bg-white rounded-full" />}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <p className="font-serif text-lg text-neutral-900 leading-tight truncate">{nameOf(active)}</p>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 text-xs text-neutral-500">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold ${statusChip(active.status).cls}`}>{statusChip(active.status).label}</span>
                      {active.identity !== 'unknown' && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-neutral-50 text-neutral-600">{active.identity === 'vendor' ? 'Vendor' : 'Ticket buyer'}</span>}
                      {active.tag && <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border capitalize ${tagCls(active.tag)}`}>{active.tag}</span>}
                      {active.phone && (
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${active.bot_paused ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-neutral-50 text-neutral-500 border-neutral-200'}`}>
                          {active.bot_paused ? <><UserCheck className="w-3 h-3" />Human handling</> : <><Bot className="w-3 h-3" />Bot active</>}
                        </span>
                      )}
                      {active.phone && <span className="inline-flex items-center gap-1"><MessageCircle className="w-3 h-3 text-emerald-600" />{active.phone}</span>}
                      {active.email && <span className="inline-flex items-center gap-1 truncate max-w-[180px]"><Mail className="w-3 h-3 text-blue-600" />{active.email}</span>}
                      {active.assignee_id && <span className="text-[10px] text-neutral-500">· {assigneeEmail(active.assignee_id)}</span>}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {active.phone && (
                    <button onClick={toggleHandover} disabled={handoverBusy}
                      title={active.bot_paused ? 'Hand back to bot' : 'Take over from bot'}
                      className="h-8 px-2 rounded-lg border border-neutral-200 hover:bg-neutral-100 flex items-center gap-1 text-[11px] font-semibold text-neutral-600 disabled:opacity-50">
                      {handoverBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : active.bot_paused ? <Bot className="w-3.5 h-3.5" /> : <UserCheck className="w-3.5 h-3.5" />}
                      {active.bot_paused ? 'Hand back' : 'Take over'}
                    </button>
                  )}
                  <div className="relative">
                    <button title="More" onClick={() => setMenuOpen((v) => !v)} className="w-8 h-8 rounded-lg hover:bg-neutral-100 flex items-center justify-center">
                      <MoreHorizontal className="w-4 h-4 text-neutral-500" />
                    </button>
                    {menuOpen && (
                      <div className="absolute right-0 top-9 z-20 w-48 bg-white border border-neutral-200 rounded-xl shadow-lg py-1 text-sm">
                        {active.status !== 'resolved'
                          ? <button onClick={() => doStatus('resolve')} className="w-full px-3 py-2 text-left hover:bg-neutral-50 flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600" />Resolve</button>
                          : <button onClick={() => doStatus('reopen')} className="w-full px-3 py-2 text-left hover:bg-neutral-50 flex items-center gap-2"><RotateCcw className="w-4 h-4 text-sky-600" />Reopen</button>}
                        {active.status !== 'snoozed'
                          ? <button onClick={() => doStatus('snooze')} className="w-full px-3 py-2 text-left hover:bg-neutral-50 flex items-center gap-2"><Clock className="w-4 h-4 text-amber-600" />Snooze</button>
                          : <button onClick={() => doStatus('reopen')} className="w-full px-3 py-2 text-left hover:bg-neutral-50 flex items-center gap-2"><RotateCcw className="w-4 h-4 text-sky-600" />Reopen</button>}
                        <button onClick={() => { runAI('summarize'); setMenuOpen(false) }} disabled={!!aiBusy} className="w-full px-3 py-2 text-left hover:bg-neutral-50 flex items-center gap-2 disabled:opacity-50">
                          {aiBusy === 'summarize' ? <Loader2 className="w-4 h-4 animate-spin text-[#cd2653]" /> : <FileText className="w-4 h-4 text-[#cd2653]" />}Summarize thread
                        </button>
                        <button onClick={() => { doStatus('unread'); setMenuOpen(false) }} className="w-full px-3 py-2 text-left hover:bg-neutral-50 flex items-center gap-2"><MailOpen className="w-4 h-4 text-neutral-500" />Mark unread</button>
                        {canned.length > 0 && (
                          <div className="relative">
                            <button onClick={() => setCannedOpen((v) => !v)} className="w-full px-3 py-2 text-left hover:bg-neutral-50 flex items-center gap-2"><MessageSquarePlus className="w-4 h-4 text-neutral-500" />Canned replies…</button>
                            {cannedOpen && (
                              <div className="absolute right-full top-0 mr-1 w-72 max-h-56 overflow-y-auto bg-white border border-neutral-200 rounded-xl shadow-lg py-1">
                                {canned.map((c) => (
                                  <button key={c.slug} onClick={() => { setReply((r) => (r ? r + '\n' + c.body : c.body)); setCannedOpen(false); setMenuOpen(false) }}
                                    className="w-full px-3 py-2 text-left hover:bg-neutral-50">
                                    <p className="text-xs font-semibold text-neutral-800">{c.label}</p>
                                    <p className="text-[11px] text-neutral-400 truncate">{c.body}</p>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        <div className="relative">
                          <button onClick={() => setTagOpen((v) => !v)} className="w-full px-3 py-2 text-left hover:bg-neutral-50 flex items-center gap-2"><TagIcon className="w-4 h-4 text-neutral-500" />Tag…</button>
                          {tagOpen && (
                            <div className="absolute right-full top-0 mr-1 w-44 bg-white border border-neutral-200 rounded-xl shadow-lg py-1">
                              {active.tag && <button onClick={() => doStatus('untag')} className="w-full px-3 py-1.5 text-left hover:bg-neutral-50 text-xs text-neutral-500">Clear tag</button>}
                              {INBOX_TAGS.map((t) => (
                                <button key={t} onClick={() => doStatus('tag', { tag: t })} className="w-full px-3 py-1.5 text-left hover:bg-neutral-50 text-xs capitalize flex items-center gap-2">
                                  <span className={`w-2 h-2 rounded-full ${tagCls(t).split(' ')[0]}`} />{t}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        {active.application_id && (
                          <button onClick={() => { setCtxOpen((v) => !v); setMenuOpen(false) }} className="w-full px-3 py-2 text-left hover:bg-neutral-50 flex items-center gap-2"><IdCard className="w-4 h-4 text-neutral-500" />{ctxOpen ? 'Hide vendor context' : 'Vendor context'}</button>
                        )}
                        <button onClick={() => { setNotesOpen((v) => !v); setMenuOpen(false) }} className="w-full px-3 py-2 text-left hover:bg-neutral-50 flex items-center gap-2"><FileText className="w-4 h-4 text-neutral-500" />{notesOpen ? 'Hide notes' : 'Internal notes'}{notes.length ? ` (${notes.length})` : ''}</button>
                        {active.application_id && (
                          <a href={`/admin/applications?focus=${active.application_id}`} className="w-full px-3 py-2 text-left hover:bg-neutral-50 flex items-center gap-2 text-neutral-600"><ExternalLink className="w-4 h-4" />Open application</a>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Messages */}
              <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-5 space-y-5 bg-neutral-50/40 min-h-0">
                {msgsLoading ? (
                  <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-neutral-400" /></div>
                ) : messages.length === 0 ? (
                  <p className="text-sm text-neutral-400 italic text-center py-8">No messages yet.</p>
                ) : grouped.map((g) => (
                  <div key={g.day} className="space-y-4">
                    <div className="flex items-center justify-center"><span className="text-[10px] font-semibold text-neutral-400 bg-white border border-neutral-200 rounded-full px-2.5 py-0.5">{g.day}</span></div>
                    {g.items.map((m) => {
                      // Three distinct outbound roles + inbound. Email renders as a
                      // full-width document card; WhatsApp stays a chat bubble.
                      const isEmail = m.channel === 'email'
                      const isBot = m.direction === 'out' && m.bot
                      const isOperator = m.direction === 'out' && !m.bot
                      // Bubble alignment: email always left (document); WA out = right.
                      const alignRight = !isEmail && m.direction === 'out'
                      // Bubble skin by role (WhatsApp only; email uses the card skin).
                      // overflow-hidden + min-w-0 keep long/raw email bodies and
                      // unbreakable URLs from blowing the bubble past the pane.
                      const bubbleSkin = isEmail
                        ? 'max-w-full w-full bg-white text-neutral-900 border border-neutral-200 rounded-lg'
                        : isBot
                          ? 'max-w-[78%] bg-neutral-100 text-neutral-700 border border-neutral-300 rounded-2xl rounded-tr-sm'
                          : isOperator
                            ? 'max-w-[78%] bg-[#cd2653] text-white rounded-2xl rounded-tr-sm'
                            : 'max-w-[78%] bg-white text-neutral-900 border border-neutral-200 rounded-2xl rounded-tl-sm'
                      // Email bodies are long, quoted, sometimes raw: render them a
                      // notch smaller than WhatsApp chat text so they stay readable
                      // and don't overflow. WhatsApp stays at a comfortable chat size.
                      const bodyText = isEmail ? 'text-[14px]' : 'text-[15px]'
                      return (
                      <div key={m.id} className={`flex flex-col min-w-0 max-w-full ${alignRight ? 'items-end' : 'items-start'}`}>
                        <div className="flex items-center gap-1.5 mb-1 px-1 text-[11px] text-neutral-400 max-w-full min-w-0">
                          {m.channel === 'whatsapp' ? <MessageCircle className="w-3 h-3 text-emerald-600 shrink-0" /> : <Mail className="w-3 h-3 text-blue-600 shrink-0" />}
                          {isBot && <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-neutral-200 text-neutral-600 font-semibold text-[10px] shrink-0"><Bot className="w-3 h-3" />Bot</span>}
                          {isOperator && <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-[#cd2653]/10 text-[#cd2653] font-semibold text-[10px] shrink-0">You</span>}
                          <span className="truncate min-w-0">{m.from}</span><span className="shrink-0">·</span><span className="shrink-0">{fmtTime(m.at)}</span>
                        </div>
                        <div className={`px-4 py-2.5 shadow-sm overflow-hidden min-w-0 ${bubbleSkin}`}>
                          {m.subject && isEmail && <p className="text-[12px] font-semibold opacity-70 mb-1 break-words">{m.subject}</p>}
                          {m.media && m.media.length > 0 && (
                            <div className={`space-y-1.5 ${m.body ? 'mb-2' : ''}`}>
                              {m.media.map((media, i) => (
                                <MediaBubble key={i} media={media} onDark={isOperator} />
                              ))}
                            </div>
                          )}
                          {m.body && (
                            <p className={`whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed ${bodyText}`}>{m.body}</p>
                          )}
                        </div>
                      </div>
                      )
                    })}
                  </div>
                ))}
              </div>

              {/* AI result strip */}
              {aiResult && (
                <div className="mx-4 mb-2 rounded-xl border border-[#cd2653]/20 bg-[#cd2653]/[0.03] px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold text-[#cd2653] flex items-center gap-1.5 mb-1"><Sparkles className="w-3 h-3" />{aiResult.title}</p>
                      <p className="text-sm text-neutral-700 whitespace-pre-wrap leading-relaxed">{aiResult.text}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => { setReply((r) => (r ? r + '\n' + aiResult.text : aiResult.text)); setAiResult(null) }} title="Insert into reply" className="text-[11px] font-semibold text-[#cd2653] hover:underline px-1">Use</button>
                      <button onClick={() => setAiResult(null)} className="w-6 h-6 rounded hover:bg-neutral-100 flex items-center justify-center"><X className="w-3.5 h-3.5 text-neutral-400" /></button>
                    </div>
                  </div>
                </div>
              )}

              {/* Outside-24h-window template prompt */}
              {windowClosed && active.phone && (
                <div className="mx-4 mb-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 flex items-center justify-between gap-2">
                  <p className="text-[11px] text-amber-800 leading-tight">Outside the 24h WhatsApp window. Send it as an approved announcement template instead.</p>
                  <button onClick={sendAsTemplate} disabled={sending || !reply.trim()}
                    className="shrink-0 text-[11px] font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg px-2.5 py-1.5 disabled:opacity-50">
                    Send as template
                  </button>
                </div>
              )}

              {/* Composer */}
              <div className="px-4 py-2.5">
                {sendMsg && <div className="mb-2 text-[11px] text-[#cd2653]">{sendMsg}</div>}
                {attachment && (
                  <div className="mb-2 inline-flex items-center gap-2 text-[11px] bg-neutral-100 border border-neutral-200 rounded-lg px-2 py-1">
                    <Paperclip className="w-3 h-3 text-neutral-500" />
                    <span className="max-w-[200px] truncate">{attachment.filename}</span>
                    <button onClick={() => setAttachment(null)} className="text-neutral-400 hover:text-neutral-700"><X className="w-3 h-3" /></button>
                  </div>
                )}
                <input ref={fileRef} type="file" className="hidden"
                  onChange={(e) => { onPickFile(e.target.files?.[0] || null); if (fileRef.current) fileRef.current.value = '' }} />
                <div className="flex items-end gap-2 rounded-xl border border-neutral-200 bg-white px-3 py-2 focus-within:border-[#cd2653]">
                  {active.phone && active.email && (
                    <select value={replyChannel} onChange={(e) => setReplyChannel(e.target.value as 'whatsapp' | 'email')}
                      className="h-8 text-xs rounded-lg border border-neutral-200 bg-white px-2 outline-none self-center">
                      <option value="whatsapp">WhatsApp</option>
                      <option value="email">Email</option>
                    </select>
                  )}
                  <button onClick={() => fileRef.current?.click()} title="Attach a file"
                    className="w-8 h-8 rounded-lg hover:bg-neutral-100 flex items-center justify-center self-center">
                    <Paperclip className="w-4 h-4 text-neutral-400" />
                  </button>
                  <textarea ref={taRef} value={reply} onChange={(e) => setReply(e.target.value)} rows={2}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitReply() } }}
                    placeholder={`Reply via ${replyChannel}…`}
                    className="flex-1 resize-none py-1.5 text-sm outline-none bg-transparent leading-relaxed" />
                  <button onClick={() => runAI('smart_reply')} disabled={!!aiBusy} title="Smart reply"
                    className="w-8 h-8 rounded-lg hover:bg-neutral-100 flex items-center justify-center self-center disabled:opacity-50">
                    {aiBusy === 'smart_reply' ? <Loader2 className="w-4 h-4 animate-spin text-[#cd2653]" /> : <Sparkles className="w-4 h-4 text-[#cd2653]" />}
                  </button>
                  <button onClick={submitReply} disabled={sending || (!reply.trim() && !attachment)}
                    className="w-9 h-9 rounded-lg bg-[#cd2653] text-white hover:bg-[#b31f47] disabled:opacity-50 flex items-center justify-center self-center">
                    {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-[10px] text-neutral-400 text-center mt-2">Zanii AI can make mistakes. Check important info before sending.</p>
              </div>
            </>
          )}
        </div>

        {/* RIGHT: list — hidden in Focus mode so the card gets the full width */}
        {!focus && (
        <div className="flex flex-col min-h-0 border border-neutral-200 rounded-2xl overflow-hidden bg-white">
          {/* Vendor context (at-a-glance facts) — relocated here so the thread
              gets the full left-column height. Toggled from the More menu. */}
          {active && ctxOpen && active.application_id && (
            <div className="border-b border-neutral-100 bg-neutral-50/60 px-4 py-3 shrink-0">
              {!ctx ? (
                <p className="text-xs text-neutral-400">Loading context…</p>
              ) : (
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border font-semibold ${statusChip(ctx.status === 'approved' ? 'open' : ctx.status).cls}`}>Status: {ctx.status}</span>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border font-semibold ${ctx.payment.status === 'paid' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-neutral-100 text-neutral-600 border-neutral-200'}`}>
                    <CreditCard className="w-3 h-3" />{ctx.payment.status}{ctx.payment.amount ? ` · R${ctx.payment.amount.toLocaleString()}` : ''}
                  </span>
                  {ctx.tier && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border bg-white text-neutral-600 border-neutral-200">{ctx.tier}</span>}
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border bg-white text-neutral-600 border-neutral-200"><MapPin className="w-3 h-3" />{ctx.stall ? `Stall ${ctx.stall}` : 'No stall yet'}</span>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border ${ctx.docs_complete ? 'bg-green-50 text-green-700 border-green-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}><FileCheck className="w-3 h-3" />Docs {ctx.docs_complete ? 'complete' : 'pending'}</span>
                  {ctx.contract_signed && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border bg-green-50 text-green-700 border-green-200">Contract signed</span>}
                </div>
              )}
            </div>
          )}

          {/* Internal notes (private to the team) — relocated to the rail. */}
          {active && notesOpen && (
            <div className="border-b border-neutral-100 bg-amber-50/40 px-4 py-3 max-h-44 overflow-y-auto shrink-0">
              <div className="flex items-center gap-1.5 mb-2 text-[10px] font-bold uppercase tracking-wider text-amber-700"><StickyNote className="w-3.5 h-3.5" />Internal notes</div>
              {!active.application_id ? (
                <p className="text-xs text-neutral-400">Internal notes are available for vendor contacts.</p>
              ) : (
                <>
                  <div className="space-y-1 mb-2">
                    {notes.length === 0
                      ? <p className="text-xs text-neutral-400">No notes yet.</p>
                      : notes.map((n, i) => (
                        <div key={i} className="text-xs text-neutral-700 leading-relaxed">
                          <span className="text-neutral-400">{n.by.split('@')[0]} · {fmtSAST(n.at)}</span> {n.text}
                        </div>
                      ))}
                  </div>
                  <div className="flex gap-2">
                    <input value={noteText} onChange={(e) => setNoteText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addNote() } }}
                      placeholder="Add a private note…"
                      className="flex-1 text-xs rounded-lg border border-neutral-200 px-2 py-1.5 outline-none focus:border-amber-500" />
                    <button onClick={addNote} disabled={!noteText.trim()} className="text-[11px] font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg px-2.5 disabled:opacity-50">Add</button>
                  </div>
                </>
              )}
            </div>
          )}

          <div className="px-4 pt-4 pb-3 border-b border-neutral-100 space-y-3">
            {/* Channel is the PRIMARY axis: a prominent segmented control,
                counted, server-side filtered via setChannel -> load(). The
                status row below stays the secondary axis. */}
            <div className="flex gap-0.5 rounded-lg bg-neutral-100 p-0.5">
              <button onClick={() => setChannel('all')}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 text-xs font-semibold px-2 py-1.5 rounded-md ${channel === 'all' ? 'bg-[#cd2653] text-white shadow-sm' : 'text-neutral-500 hover:text-neutral-900'}`}>
                All{counts ? ` (${counts.all})` : ''}
              </button>
              <button onClick={() => setChannel('whatsapp')}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 text-xs font-semibold px-2 py-1.5 rounded-md ${channel === 'whatsapp' ? 'bg-[#cd2653] text-white shadow-sm' : 'text-neutral-500 hover:text-neutral-900'}`}>
                <MessageCircle className={`w-3.5 h-3.5 ${channel === 'whatsapp' ? 'text-white' : 'text-emerald-600'}`} />WhatsApp{counts ? ` (${counts.whatsapp})` : ''}
              </button>
              <button onClick={() => setChannel('email')}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 text-xs font-semibold px-2 py-1.5 rounded-md ${channel === 'email' ? 'bg-[#cd2653] text-white shadow-sm' : 'text-neutral-500 hover:text-neutral-900'}`}>
                <Mail className={`w-3.5 h-3.5 ${channel === 'email' ? 'text-white' : 'text-blue-600'}`} />Email{counts ? ` (${counts.email})` : ''}
              </button>
            </div>
            <div className="flex gap-0.5 rounded-lg bg-neutral-100 p-0.5">
              {(['all', 'unread', 'open', 'resolved'] as const).map((t) => (
                <button key={t} onClick={() => { setTab(t); setFocusMode(false) }}
                  className={`flex-1 text-[11px] font-semibold px-1 py-1 rounded-md capitalize ${tab === t ? 'bg-white text-[#cd2653] shadow-sm' : 'text-neutral-500 hover:text-neutral-900'}`}>
                  {t}{t === 'unread' && counts?.unread ? ` ${counts.unread}` : ''}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-neutral-400 absolute left-2.5 top-2.5" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, phone, email…"
                className="w-full rounded-lg bg-neutral-50 border border-neutral-200 pl-8 pr-3 py-2 text-sm outline-none focus:border-[#cd2653] focus:bg-white" />
            </div>
            {/* Compact tag filter — a single searchable dropdown instead of the
                old wall of chips. Drives the same `tagFilter` state, so the
                filtering function is unchanged; only the presentation shrank. */}
            <div className="flex items-center gap-2">
              <div className={`relative flex-1 inline-flex items-center rounded-lg border ${tagFilter ? tagCls(tagFilter) : 'border-neutral-200 bg-neutral-50'}`}>
                <TagIcon className={`w-3.5 h-3.5 absolute left-2.5 pointer-events-none ${tagFilter ? '' : 'text-neutral-400'}`} />
                <select value={tagFilter ?? ''} onChange={(e) => setTagFilter((e.target.value || null) as InboxTag | null)}
                  className={`w-full appearance-none bg-transparent pl-8 pr-7 py-1.5 text-xs font-semibold capitalize outline-none cursor-pointer ${tagFilter ? '' : 'text-neutral-600'}`}>
                  <option value="">Filter by tag…</option>
                  {INBOX_TAGS.map((t) => <option key={t} value={t} className="capitalize">{t}</option>)}
                </select>
                <ChevronDown className={`w-3.5 h-3.5 absolute right-2.5 pointer-events-none ${tagFilter ? '' : 'text-neutral-400'}`} />
              </div>
              {tagFilter && (
                <button onClick={() => setTagFilter(null)} title="Clear tag filter"
                  className="w-7 h-7 rounded-lg border border-neutral-200 hover:bg-neutral-100 flex items-center justify-center shrink-0">
                  <X className="w-3.5 h-3.5 text-neutral-500" />
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto min-h-0">
            {loading ? (
              <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-neutral-400" /></div>
            ) : filtered.length === 0 ? (
              tab === 'needs'
                ? <div className="p-8 text-center"><Check className="w-6 h-6 text-emerald-500 mx-auto mb-2" /><p className="text-sm font-semibold text-neutral-700">You&apos;re all caught up.</p><p className="text-xs text-neutral-400 mt-0.5">Nobody is waiting on a human right now.</p></div>
                : <p className="p-6 text-sm text-neutral-400 text-center">No conversations match.</p>
            ) : (
              <div className="divide-y divide-neutral-100">
                {filtered.map((c) => {
                  const isActive = active?.id === c.id
                  const name = nameOf(c)
                  return (
                    <button key={c.id} onClick={() => setActiveId(c.id)}
                      className={`w-full text-left px-4 py-3 flex items-start gap-3 ${isActive ? 'bg-[#cd2653]/5' : 'hover:bg-neutral-50'}`}>
                      <div className="relative shrink-0">
                        <div className="w-10 h-10 rounded-full bg-neutral-100 text-neutral-600 flex items-center justify-center text-xs font-bold">{initials(name)}</div>
                        <span className="absolute -bottom-0.5 -right-0.5 flex gap-0.5">
                          {c.channels.includes('whatsapp') && <MessageCircle className="w-3 h-3 text-emerald-600 bg-white rounded-full" />}
                          {c.channels.includes('email') && <Mail className="w-3 h-3 text-blue-600 bg-white rounded-full" />}
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className={`text-sm truncate ${c.unread ? 'font-bold text-neutral-900' : 'font-semibold text-neutral-800'}`}>{name}</p>
                          <span className="text-[11px] text-neutral-400 shrink-0 flex items-center gap-1">
                            {c.starred && <Star className="w-3 h-3 fill-amber-400 text-amber-400" />}
                            {fmtSAST(c.last_message_at)}
                          </span>
                        </div>
                        <p className={`text-xs truncate mt-0.5 ${c.unread ? 'text-neutral-700 font-medium' : 'text-neutral-500'}`}>{c.last_preview || c.email || c.phone || ''}</p>
                        <div className="flex items-center gap-1.5 mt-1.5">
                          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${statusChip(c.status).cls}`}>{statusChip(c.status).label}</span>
                          {c.tag && <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border capitalize ${tagCls(c.tag)}`}>{c.tag}</span>}
                          {c.identity !== 'unknown' && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-neutral-50 text-neutral-600">{c.identity === 'vendor' ? 'vendor' : 'ticket'}</span>}
                          {c.unread && <span className="ml-auto w-2 h-2 rounded-full bg-[#cd2653]" />}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
        )}
      </div>
    </AdminPage>
  )
}
