'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { usePathname } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { MessageCircle, X, Send, Loader2 } from 'lucide-react'
import {
  clampDock, parseDock, isDrag, panelPosition, DOCK_STORAGE_KEY, type DockPos,
} from '@/lib/dock-position'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

const WELCOME_PUBLIC = "Hey! I'm your festival concierge. Ask me about tickets, where to stay, how to get there, what to eat, or anything to plan your perfect weekend at Young at Heart 2026."
const WELCOME_ADMIN = "Hi! I'm your admin assistant. Ask me about vendor applications, ticket sales, analytics, or anything about managing the festival."

export function ChatWidget() {
  const pathname = usePathname()
  const isAdmin = pathname.startsWith('/admin')
  // Exhibitor portal = the vendor surface (gets vendor-platform answers; the
  // server still verifies a real exhibitor session before answering).
  const surface: 'admin' | 'vendor' | 'public' = isAdmin
    ? 'admin'
    : pathname.startsWith('/exhibitor')
      ? 'vendor'
      : 'public'
  const [open, setOpen] = useState(false)

  // ── Draggable dock ───────────────────────────────────────────────────────
  // null means "wherever the CSS puts it" (bottom-6 right-6), so the very first
  // render is identical to before and nothing jumps. A position only exists once
  // the operator has actually moved it.
  const [dock, setDock] = useState<DockPos | null>(null)
  const [dragging, setDragging] = useState(false)
  /** Where the panel opens, derived from the bubble. null = the CSS default. */
  const [panel, setPanel] = useState<ReturnType<typeof panelPosition> | null>(null)
  const grabRef = useRef({ dx: 0, dy: 0, sx: 0, sy: 0 })
  /** True when the press that is ending was a drag, so it must not also open. */
  const draggedRef = useRef(false)

  useEffect(() => {
    const saved = parseDock(localStorage.getItem(DOCK_STORAGE_KEY))
    if (saved) setDock(clampDock(saved, window.innerWidth, window.innerHeight))
  }, [])

  // Re-clamp on resize. A bubble parked at the right edge of a wide window ends
  // up outside a narrow one, and something you cannot see is something you
  // cannot drag back.
  useEffect(() => {
    const onResize = () =>
      setDock((p) => (p ? clampDock(p, window.innerWidth, window.innerHeight) : p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Recompute the panel whenever the bubble moves or the window changes size.
  // Derived rather than stored: the panel has no position of its own to drift
  // out of sync with the bubble's.
  useEffect(() => {
    if (!dock) { setPanel(null); return }
    const place = () => setPanel(panelPosition(dock, window.innerWidth, window.innerHeight))
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [dock])

  function onDockPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    const r = e.currentTarget.getBoundingClientRect()
    grabRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY }
    draggedRef.current = false
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }

  function onDockPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    if (!dragging) return
    const { dx, dy, sx, sy } = grabRef.current
    if (!draggedRef.current && !isDrag(e.clientX - sx, e.clientY - sy)) return
    draggedRef.current = true
    setDock(clampDock(
      { x: e.clientX - dx, y: e.clientY - dy },
      window.innerWidth, window.innerHeight,
    ))
  }

  function onDockPointerUp() {
    if (!dragging) return
    setDragging(false)
    // Persist only a real move. A plain click must not silently pin the bubble
    // to coordinates the operator never chose.
    if (draggedRef.current) {
      setDock((p) => {
        if (p) { try { localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(p)) } catch { /* private mode */ } }
        return p
      })
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: isAdmin ? WELCOME_ADMIN : WELCOME_PUBLIC },
  ])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus()
    }
  }, [open])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || sending) return

    const userMsg: Message = { role: 'user', content: text }
    const updated = [...messages, userMsg]
    setMessages(updated)
    setInput('')
    setSending(true)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: updated, context: surface }),
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.error || 'Failed')
      }

      const data = await res.json()
      setMessages(prev => [...prev, { role: 'assistant', content: data.message }])
    } catch {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: "Sorry, I'm having trouble right now. Please email support@youngatheart.co.za or call 065 943 5012.",
      }])
    } finally {
      setSending(false)
    }
  }, [input, sending, messages])

  return (
    <>
      {/* Floating Button — DRAGGABLE.
          It sat at a fixed bottom-right and covered the inbox composer's Send
          button. Reserving space inside the composer fixed that one collision by
          narrowing the reply box for everyone forever, so instead the bubble
          moves: drag it anywhere, it stays there, and it is clamped back into
          view on resize. Taona 2026-07-28: "put it back and just make the chat
          thing moveable". */}
      <AnimatePresence>
        {!open && (
          <motion.button
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            onPointerDown={onDockPointerDown}
            onPointerMove={onDockPointerMove}
            onPointerUp={onDockPointerUp}
            onPointerCancel={onDockPointerUp}
            onClick={() => { if (!draggedRef.current) setOpen(true) }}
            style={dock
              ? { left: dock.x, top: dock.y, right: 'auto', bottom: 'auto', touchAction: 'none', cursor: dragging ? 'grabbing' : 'grab' }
              : { touchAction: 'none', cursor: 'grab' }}
            className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-[#cd2653] text-white shadow-lg shadow-[#cd2653]/25 flex items-center justify-center hover:bg-[#b01f45] transition-colors"
            aria-label="Open chat. Drag to move."
            title="Drag to move"
          >
            <MessageCircle className="w-6 h-6" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* Chat Window */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            // Follows the bubble. panelPosition anchors it above and
            // right-aligned, flips below when there is no room, and clamps so a
            // 380x520 window can never open half off-screen no matter which
            // corner the bubble was dragged into.
            style={panel
              ? { left: panel.left, top: panel.top, width: panel.width, height: panel.height, right: 'auto', bottom: 'auto' }
              : undefined}
            className="fixed bottom-6 right-6 z-50 w-[380px] max-w-[calc(100vw-48px)] h-[520px] max-h-[calc(100vh-48px)] bg-white rounded-2xl shadow-2xl border border-neutral-200 flex flex-col overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-100 bg-white">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-[#cd2653] flex items-center justify-center">
                  <MessageCircle className="w-4.5 h-4.5 text-white" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-neutral-900">Festival Assistant</p>
                  <p className="text-[11px] text-green-600 font-medium flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                    Online
                  </p>
                </div>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="w-8 h-8 rounded-lg hover:bg-neutral-100 flex items-center justify-center transition-colors"
                aria-label="Close chat"
              >
                <X className="w-4 h-4 text-neutral-500" />
              </button>
            </div>

            {/* Messages */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-[#cd2653] text-white rounded-br-md'
                      : 'bg-neutral-100 text-neutral-800 rounded-bl-md'
                  }`}>
                    {msg.content}
                  </div>
                </div>
              ))}
              {sending && (
                <div className="flex justify-start">
                  <div className="bg-neutral-100 rounded-2xl rounded-bl-md px-4 py-3">
                    <Loader2 className="w-4 h-4 animate-spin text-neutral-400" />
                  </div>
                </div>
              )}
            </div>

            {/* Input */}
            <div className="px-4 py-3 border-t border-neutral-100 bg-white">
              <div className="flex items-center gap-2">
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                  placeholder="Plan your weekend with us..."
                  className="flex-1 px-4 py-2.5 bg-neutral-50 border border-neutral-200 rounded-xl text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:border-[#cd2653] focus:ring-1 focus:ring-[#cd2653]/20 transition-colors"
                  disabled={sending}
                />
                <button
                  onClick={send}
                  disabled={!input.trim() || sending}
                  className="w-10 h-10 rounded-xl bg-[#cd2653] text-white flex items-center justify-center hover:bg-[#b01f45] disabled:opacity-40 disabled:hover:bg-[#cd2653] transition-colors flex-shrink-0"
                  aria-label="Send message"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
              <p className="text-[10px] text-neutral-400 text-center mt-2">
                Plan your weekend · support@youngatheart.co.za
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
