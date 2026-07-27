'use client'

/**
 * The reply box, shared by all three channel workspaces.
 *
 * THE 24-HOUR WINDOW IS THE REASON THIS EXISTS. Meta only allows a free-form
 * WhatsApp reply within 24 hours of the vendor's last message. Outside it,
 * /unified/reply returns 409 {windowClosed:true} and NOTHING IS SENT. The new
 * tabs shipped with a bare textarea that treated that as a generic error, so an
 * operator could type a careful reply to a vendor who had gone quiet for a day,
 * press send, and have it vanish. The old inbox handled this and the rebuild
 * dropped it.
 *
 * On a 409 the composer keeps the text, explains the window in a sentence, and
 * offers the one thing Meta does allow: an approved announcement template.
 *
 * Also here because every channel needs them and none of them had them:
 * attachments, an AI draft, and canned replies.
 */

import { useEffect, useRef, useState } from 'react'
import { Send, Loader2, Paperclip, Sparkles, X, MessageSquareQuote, FolderOpen } from 'lucide-react'

export interface SendResult {
  ok: boolean
  /** Meta's 24h free-form window has closed: only a template may go out. */
  windowClosed?: boolean
  message?: string
}

interface Props {
  channel: 'whatsapp' | 'email'
  /** Identifier the reply/ai endpoints key on. */
  phone?: string | null
  email?: string | null
  /** Shown above the box on email so the operator knows which identity replies. */
  sendingAs?: string
  subject?: string | null
  /** Vendor this thread belongs to, if any. Drives the send library. */
  applicationId?: string | null
  onSent: () => void
  onError: (msg: string) => void
}

interface Canned { id: string; title: string; body: string }

const MAX_BYTES = 4_000_000

export function Composer({ channel, phone, email, sendingAs, subject, applicationId, onSent, onError }: Props) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [windowClosed, setWindowClosed] = useState(false)
  const [file, setFile] = useState<{ name: string; type: string; b64: string } | null>(null)
  const [canned, setCanned] = useState<Canned[]>([])
  const [cannedOpen, setCannedOpen] = useState(false)
  const [libOpen, setLibOpen] = useState(false)
  const [lib, setLib] = useState<Array<{ key: string; label: string; description: string }>>([])
  const [libBusy, setLibBusy] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // A new inbound reopens the window, so never leave the banner up across threads.
  useEffect(() => { setWindowClosed(false) }, [phone, email])

  useEffect(() => {
    if (!cannedOpen || canned.length) return
    fetch('/api/admin/support-inbox/canned', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { canned: [] }))
      .then((j) => setCanned(j.canned || j.replies || []))
      .catch(() => {})
  }, [cannedOpen, canned.length])

  useEffect(() => {
    if (!libOpen || !applicationId || lib.length) return
    fetch(`/api/admin/inbox/send-library?applicationId=${applicationId}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((j) => setLib(j.items || []))
      .catch(() => {})
  }, [libOpen, applicationId, lib.length])

  /** Send a library item. The server builds it and reports honestly when it
   *  cannot, so this never claims a delivery that did not happen. */
  async function sendFromLibrary(key: string) {
    if (!applicationId) return
    setLibBusy(key)
    try {
      const r = await fetch('/api/admin/inbox/send-library', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ applicationId, key, channel, ...(phone ? { phone } : {}), ...(email ? { email } : {}) }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.ok === false) throw new Error(j.message || `Could not send that (${r.status})`)
      setLibOpen(false)
      onSent()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setLibBusy(null)
    }
  }

  async function pickFile(f: File) {
    if (f.size > MAX_BYTES) { onError(`${f.name} is too large (max 4MB).`); return }
    const buf = await f.arrayBuffer()
    let bin = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    setFile({ name: f.name, type: f.type || 'application/octet-stream', b64: btoa(bin) })
  }

  async function post(mode: 'text' | 'template') {
    const body = text.trim()
    if (!body && !file) return
    setSending(true)
    try {
      const r = await fetch('/api/admin/inbox/unified/reply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channel, mode,
          ...(phone ? { phone } : {}),
          ...(email ? { email } : {}),
          ...(subject ? { subject } : {}),
          text: body,
          ...(file ? { attachment: { filename: file.name, contentType: file.type, dataBase64: file.b64 } } : {}),
        }),
      })
      const j: SendResult = await r.json().catch(() => ({ ok: false }))
      if (r.status === 409 && j.windowClosed) {
        // Keep the text. Losing what she typed is the whole injury here.
        setWindowClosed(true)
        onError(j.message || 'Outside the 24 hour WhatsApp window.')
        return
      }
      if (!r.ok || j.ok === false) throw new Error(j.message || `Send failed (${r.status})`)
      setText(''); setFile(null); setWindowClosed(false)
      onSent()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setSending(false)
    }
  }

  async function aiDraft() {
    setAiBusy(true)
    try {
      const r = await fetch('/api/admin/inbox/unified/ai', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'smart_reply', ...(phone ? { phone } : {}), ...(email ? { email } : {}) }),
      })
      const j = await r.json().catch(() => ({}))
      if (!j.ok) throw new Error(j.message || 'AI could not draft that.')
      setText(j.text || '')
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setAiBusy(false)
    }
  }

  const isEmail = channel === 'email'

  return (
    <div>
      {windowClosed && (
        <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <p className="font-medium">This chat is outside WhatsApp&apos;s 24 hour reply window.</p>
          <p className="mt-0.5">
            Meta only allows a free-form message within 24 hours of their last one. Your text is still here.
            Send it as an approved announcement instead, or wait for them to write again.
          </p>
          <button
            onClick={() => post('template')}
            disabled={sending}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-60"
          >
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Send as announcement
          </button>
        </div>
      )}

      {sendingAs && (
        <p className="mb-1.5 text-[11px] text-neutral-500">
          Replying as <span className="font-medium text-neutral-700">{sendingAs}</span>
          {subject ? <> · <span className="text-neutral-600">Re: {subject.replace(/^re:\s*/i, '')}</span></> : null}
        </p>
      )}

      {file && (
        <div className="mb-2 inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 text-xs text-neutral-700">
          <Paperclip className="h-3.5 w-3.5 text-neutral-400" />
          <span className="max-w-[220px] truncate">{file.name}</span>
          <button onClick={() => setFile(null)} aria-label="Remove attachment" className="text-neutral-400 hover:text-neutral-700">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="flex items-end gap-2">
        <div className="relative flex-1">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Email is long-form: Enter makes a paragraph, Cmd+Enter sends.
              // Chat is not: Enter sends.
              const send = isEmail ? e.key === 'Enter' && (e.metaKey || e.ctrlKey) : e.key === 'Enter' && !e.shiftKey
              if (send) { e.preventDefault(); post('text') }
            }}
            rows={isEmail ? 4 : 1}
            placeholder={isEmail ? 'Write a reply. Cmd+Enter to send.' : 'Write a message'}
            className={`w-full ${isEmail ? 'resize-y' : 'resize-none max-h-40'} px-3 py-2 pr-20 text-sm rounded-lg border border-neutral-200 focus:outline-none focus:ring-2 focus:ring-neutral-900/10`}
          />
          <div className="absolute right-2 bottom-2 flex items-center gap-1">
            {applicationId && (
              <button onClick={() => setLibOpen((o) => !o)} title="Send a document or link"
                className="h-7 w-7 grid place-items-center rounded-md text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100">
                <FolderOpen className="h-4 w-4" />
              </button>
            )}
            <button onClick={() => setCannedOpen((o) => !o)} title="Canned replies"
              className="h-7 w-7 grid place-items-center rounded-md text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100">
              <MessageSquareQuote className="h-4 w-4" />
            </button>
            <button onClick={() => fileInput.current?.click()} title="Attach a file"
              className="h-7 w-7 grid place-items-center rounded-md text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100">
              <Paperclip className="h-4 w-4" />
            </button>
            <button onClick={aiDraft} disabled={aiBusy} title="Draft a reply with AI"
              className="h-7 w-7 grid place-items-center rounded-md text-neutral-400 hover:text-[#cd2653] hover:bg-neutral-100 disabled:opacity-50">
              {aiBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            </button>
          </div>

          {libOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setLibOpen(false)} />
              <div className="absolute bottom-full mb-1 right-0 z-20 w-80 max-h-72 overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-lg py-1">
                <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                  Send to this vendor
                </p>
                {lib.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-neutral-500">Nothing available for this vendor.</p>
                ) : lib.map((it) => (
                  <button
                    key={it.key}
                    onClick={() => sendFromLibrary(it.key)}
                    disabled={!!libBusy}
                    className="w-full text-left px-3 py-2 hover:bg-neutral-50 disabled:opacity-50"
                  >
                    <p className="text-xs font-medium text-neutral-800 flex items-center gap-1.5">
                      {libBusy === it.key && <Loader2 className="h-3 w-3 animate-spin" />}
                      {it.label}
                    </p>
                    <p className="text-xs text-neutral-500">{it.description}</p>
                  </button>
                ))}
              </div>
            </>
          )}

          {cannedOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setCannedOpen(false)} />
              <div className="absolute bottom-full mb-1 right-0 z-20 w-80 max-h-64 overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-lg py-1">
                {canned.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-neutral-500">No canned replies saved.</p>
                ) : canned.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => { setText(c.body); setCannedOpen(false) }}
                    className="w-full text-left px-3 py-2 hover:bg-neutral-50"
                  >
                    <p className="text-xs font-medium text-neutral-800">{c.title}</p>
                    <p className="text-xs text-neutral-500 truncate">{c.body}</p>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <button
          onClick={() => post('text')}
          disabled={(!text.trim() && !file) || sending}
          className="h-9 w-9 grid place-items-center rounded-lg bg-neutral-900 text-white disabled:opacity-40"
          aria-label="Send"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </div>

      <input
        ref={fileInput}
        type="file"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f); e.target.value = '' }}
      />
    </div>
  )
}
