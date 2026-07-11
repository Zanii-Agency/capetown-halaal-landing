'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Send } from 'lucide-react'

interface ZoneOption {
  key: string
  label: string
}

interface Props {
  stallCode: string | null
  zones: ZoneOption[]
}

export function StallMoveForm({ stallCode, zones }: Props) {
  const router = useRouter()
  const [zone, setZone] = useState('')
  const [details, setDetails] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!details.trim()) { setError('Please tell us what you need.'); return }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/exhibitor/stand/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferredZone: zone || undefined, details }),
      })
      const j = await res.json()
      if (!res.ok) { setError(j.error || 'Failed to submit request'); return }
      setSuccess(true)
      router.refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (success) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-center">
        <p className="text-sm font-medium text-emerald-800">Stall request submitted.</p>
        <p className="text-xs text-emerald-600 mt-1">
          The organisers will take your preference into account when they place you. They will follow up with you.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="rounded-xl border border-neutral-200 bg-white p-5 space-y-4">
        <div>
          <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Current position</p>
          <p className="text-sm font-medium text-neutral-900 mt-1">
            {stallCode ? stallCode : 'Not allocated yet'}
          </p>
        </div>

        <div>
          <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider block mb-2">
            Preferred area (optional)
          </label>
          <select
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-[#cd2653]"
          >
            <option value="">No preference</option>
            {zones.map((z) => (
              <option key={z.key} value={z.key}>{z.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider block mb-2">
            What do you need?
          </label>
          <textarea
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            rows={3}
            placeholder="e.g. A corner stall, near the entrance, or away from a specific vendor. Tell the organisers your preference."
            className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#cd2653] resize-none"
          />
        </div>

        <p className="text-xs text-neutral-500">
          This is a preference, not a guarantee. You can send this even before a stall is allocated. The organisers confirm every position.
        </p>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={saving || !details.trim()}
        className="inline-flex items-center gap-2 bg-[#cd2653] hover:bg-[#b01f45] text-white text-sm font-medium rounded-full px-6 py-2.5 transition-colors disabled:opacity-60"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        Submit stall request
      </button>
    </form>
  )
}
