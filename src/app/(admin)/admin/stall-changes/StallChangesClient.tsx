'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ArrowRight, Check, Loader2, X, Inbox } from 'lucide-react'
import { PageShell, PageHeader, Card } from '@/components/chrome/PageChrome'

interface ChangeRequest {
  id: string
  business_name: string
  currentTier: string
  currentTierLabel: string
  requestedTier: string
  requestedTierLabel: string
  reason: string
  requestedAt: string | null
}

interface MoveRequest {
  id: string
  business_name: string
  preferredZone: string | null
  preferredZoneLabel: string | null
  currentStall: string | null
  details: string
  requestedAt: string | null
}

function formatDateTime(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('en-ZA', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export function StallChangesClient() {
  const [requests, setRequests] = useState<ChangeRequest[] | null>(null)
  const [moveRequests, setMoveRequests] = useState<MoveRequest[] | null>(null)
  const [error, setError] = useState('')
  // Tracks the id currently being acted on so we can disable both buttons and
  // spin the right one.
  const [busy, setBusy] = useState<{ id: string; action: 'approve' | 'reject' } | null>(null)

  const load = () => {
    setError('')
    fetch('/api/admin/stall-changes')
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) {
          window.location.href = '/admin/login'
          return
        }
        if (!res.ok) throw new Error(`Server ${res.status}`)
        const body = await res.json()
        setRequests(body.requests || [])
        setMoveRequests(body.moveRequests || [])
      })
      .catch((e) => setError(e.message || 'Failed to load'))
  }

  // When the matcher cannot resolve a vendor's own wording (a "2.4m x 1.8m
  // trailer" is not one of our ten tiers), the API now returns the tier list so
  // we can ASK instead of dead-ending the operator on another page.
  const [pick, setPick] = useState<{ reqId: string; text: string; tiers: { slug: string; label: string; price: number }[] } | null>(null)

  useEffect(load, [])

  const act = async (req: ChangeRequest, action: 'approve' | 'reject', tier?: string) => {
    setBusy({ id: req.id, action })
    try {
      const res = await fetch('/api/admin/stall-changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: req.id, action, kind: 'size', ...(tier ? { tier } : {}) }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // Not an error to shout about: the vendor described their own equipment
        // and we simply need to know which tier it maps to.
        if (body.code === 'UNRESOLVED_TIER' && Array.isArray(body.tiers)) {
          setPick({ reqId: req.id, text: String(body.requestedText || req.requestedTierLabel), tiers: body.tiers })
          return
        }
        throw new Error(body.error || `Server ${res.status}`)
      }
      setPick(null)
      toast.success(
        action === 'approve'
          ? `${req.business_name} moved to ${req.requestedTierLabel}`
          : `${req.business_name}'s request declined`,
      )
      // Optimistically drop the resolved request from the queue.
      setRequests((prev) => (prev || []).filter((r) => r.id !== req.id))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  const actMove = async (req: MoveRequest, action: 'approve' | 'reject') => {
    setBusy({ id: req.id, action })
    try {
      const res = await fetch('/api/admin/stall-changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: req.id, action, kind: 'move' }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `Server ${res.status}`)
      toast.success(
        action === 'approve'
          ? `${req.business_name}'s position request acknowledged`
          : `${req.business_name}'s position request declined`,
      )
      setMoveRequests((prev) => (prev || []).filter((r) => r.id !== req.id))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <PageShell>
      <PageHeader
        kicker="Operations"
        title="Stall Requests"
        subtitle="Two queues: stall SIZE changes (approving moves the vendor to the new tier) and stall POSITION requests (a preference — re-allocate on Vendor Ops). Neither touches allocation automatically."
      />

      <h2 className="text-sm font-semibold text-[#1B1A17] mt-2 mb-1">Stall size changes</h2>

      {error && (
        <Card>
          <p className="text-sm text-[#bf3026]">{error}</p>
        </Card>
      )}

      {requests === null && !error && (
        <Card>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-[#1B1A17]/45" />
          </div>
        </Card>
      )}

      {requests !== null && requests.length === 0 && (
        <Card>
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Inbox className="w-8 h-8 text-[#1B1A17]/25 mb-3" />
            <p className="text-sm font-medium text-[#1B1A17]">No pending stall changes</p>
            <p className="text-xs text-[#1B1A17]/45 mt-1">
              Vendor requests will appear here as soon as they come in.
            </p>
          </div>
        </Card>
      )}

      {requests !== null && requests.length > 0 && (
        <div className="space-y-3">
          {requests.map((req) => {
            const isBusy = busy?.id === req.id
            return (
              <Card key={req.id}>
                <div className="flex flex-wrap items-start gap-4">
                  <div className="flex-1 min-w-[240px]">
                    <p className="text-sm font-semibold text-[#1B1A17]">{req.business_name}</p>
                    <div className="flex items-center gap-2 mt-1.5 text-sm text-[#1B1A17]/70">
                      <span>{req.currentTierLabel}</span>
                      <ArrowRight className="w-3.5 h-3.5 text-[#cd2653]" />
                      <span className="font-medium text-[#1B1A17]">{req.requestedTierLabel}</span>
                    </div>
                    {req.reason && (
                      <p className="text-xs text-[#1B1A17]/55 mt-2">
                        <span className="font-semibold">Reason:</span> {req.reason}
                      </p>
                    )}
                    {req.requestedAt && (
                      <p className="text-[11px] text-[#1B1A17]/40 mt-2">
                        Requested {formatDateTime(req.requestedAt)}
                      </p>
                    )}

                    {pick?.reqId === req.id && (
                      <div className="mt-3 rounded-xl border border-[#cd2653]/30 bg-[#cd2653]/5 p-3">
                        <p className="text-xs text-[#1B1A17]/75">
                          <span className="font-semibold">&ldquo;{pick.text}&rdquo;</span> is not one of our stall
                          sizes. Which tier should they move to?
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {pick.tiers.map((t) => (
                            <button
                              key={t.slug}
                              type="button"
                              disabled={isBusy}
                              onClick={() => act(req, 'approve', t.slug)}
                              className="px-2.5 py-1.5 rounded-lg border border-[#B8924A]/40 bg-white text-xs font-medium text-[#1B1A17] hover:border-[#cd2653] hover:text-[#cd2653] disabled:opacity-50"
                            >
                              {t.label} <span className="text-[#1B1A17]/45">R{t.price.toLocaleString('en-ZA')}</span>
                            </button>
                          ))}
                        </div>
                        <button
                          type="button"
                          onClick={() => setPick(null)}
                          className="mt-2 text-[11px] text-[#1B1A17]/50 underline underline-offset-2"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => act(req, 'reject')}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-[#E5E5E5]/60 text-sm font-semibold text-[#1B1A17]/70 hover:bg-[#FAFAFA] disabled:opacity-50"
                    >
                      {isBusy && busy?.action === 'reject'
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <X className="w-3.5 h-3.5" />}
                      Reject
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => act(req, 'approve')}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#cd2653] text-sm font-semibold text-white hover:bg-[#bf3026] disabled:opacity-50"
                    >
                      {isBusy && busy?.action === 'approve'
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <Check className="w-3.5 h-3.5" />}
                      Approve
                    </button>
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      <h2 className="text-sm font-semibold text-[#1B1A17] mt-8 mb-1">Stall position requests</h2>

      {moveRequests !== null && moveRequests.length === 0 && (
        <Card>
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Inbox className="w-7 h-7 text-[#1B1A17]/25 mb-2" />
            <p className="text-sm font-medium text-[#1B1A17]">No pending position requests</p>
            <p className="text-xs text-[#1B1A17]/45 mt-1">Vendors asking for a different spot appear here.</p>
          </div>
        </Card>
      )}

      {moveRequests !== null && moveRequests.length > 0 && (
        <div className="space-y-3">
          {moveRequests.map((req) => {
            const isBusy = busy?.id === req.id
            return (
              <Card key={req.id}>
                <div className="flex flex-wrap items-start gap-4">
                  <div className="flex-1 min-w-[240px]">
                    <p className="text-sm font-semibold text-[#1B1A17]">{req.business_name}</p>
                    <div className="flex items-center gap-2 mt-1.5 text-sm text-[#1B1A17]/70">
                      <span>{req.currentStall ? `Currently ${req.currentStall}` : 'Not yet allocated'}</span>
                      {req.preferredZoneLabel && (
                        <>
                          <ArrowRight className="w-3.5 h-3.5 text-[#cd2653]" />
                          <span className="font-medium text-[#1B1A17]">Prefers {req.preferredZoneLabel}</span>
                        </>
                      )}
                    </div>
                    {req.details && (
                      <p className="text-xs text-[#1B1A17]/55 mt-2">
                        <span className="font-semibold">Asked for:</span> {req.details}
                      </p>
                    )}
                    {req.requestedAt && (
                      <p className="text-[11px] text-[#1B1A17]/40 mt-2">
                        Requested {formatDateTime(req.requestedAt)}
                      </p>
                    )}

                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => actMove(req, 'reject')}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-[#E5E5E5]/60 text-sm font-semibold text-[#1B1A17]/70 hover:bg-[#FAFAFA] disabled:opacity-50"
                    >
                      {isBusy && busy?.action === 'reject'
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <X className="w-3.5 h-3.5" />}
                      Decline
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => actMove(req, 'approve')}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#cd2653] text-sm font-semibold text-white hover:bg-[#bf3026] disabled:opacity-50"
                    >
                      {isBusy && busy?.action === 'approve'
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <Check className="w-3.5 h-3.5" />}
                      Acknowledge
                    </button>
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </PageShell>
  )
}
