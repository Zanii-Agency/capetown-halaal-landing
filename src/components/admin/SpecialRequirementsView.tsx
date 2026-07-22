// Readable renderer for a vendor's special_requirements blob. The column is a
// JSON string (or object) written by the apply form. Showing it raw dumps
// {"traded_before":"Yes",...} at the operator, which is unreadable. This parses
// it and renders humanised label/value rows (words, not JSON). Shared by the
// applications PreviewPane AND the vendor detail page (Vendor360), so both
// surfaces stay consistent. Samreen flagged the raw-JSON dump 2026-07-22.

const FIELD_LABELS: Record<string, string> = {
  traded_before: 'Traded before',
  social_media: 'Social media',
  stall_type: 'Stall type',
  stall_price: 'Stall price',
  electrical_appliances: 'Electrical appliances',
  electrical_custom: 'Custom charges',
  appliance_details: 'Appliance details',
  uses_gas: 'Uses gas',
  total_estimate: 'Total estimate',
  power_supply: 'Power supply',
  water_required: 'Water required',
  hired_chairs: 'Chairs hired',
  hired_tables: 'Tables hired',
  notes: 'Notes',
}

// Internal/derived keys that shouldn't be shown to the operator as-is.
const HIDDEN_KEYS = new Set<string>([])

function humaniseKey(k: string): string {
  if (FIELD_LABELS[k]) return FIELD_LABELS[k]
  return k.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const rand = (n: number) => `R${Number(n || 0).toLocaleString('en-ZA')}`

function formatValue(k: string, v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'number') {
    if (/price|estimate|cost|fee|amount/i.test(k)) return rand(v)
    return String(v)
  }
  // electrical_custom: Array<{ label, amount, qty }> -> "OUTDOOR 2*2 x1: R2,000"
  if (Array.isArray(v)) {
    const parts = v
      .map((item) => {
        if (item && typeof item === 'object') {
          const o = item as { label?: unknown; amount?: unknown; qty?: unknown }
          const label = String(o.label ?? '').trim() || 'Charge'
          const qty = Number(o.qty) > 1 ? ` x${Number(o.qty)}` : ''
          const amt = Number.isFinite(Number(o.amount)) ? `: ${rand(Number(o.amount))}` : ''
          return `${label}${qty}${amt}`
        }
        return String(item)
      })
      .filter(Boolean)
    return parts.length ? parts.join('; ') : ''
  }
  // electrical_appliances: { slug: qty } -> "microwave x1, urn x2" (or "None")
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([key, qty]) => key !== 'none' && Number(qty) > 0)
      .map(([key, qty]) => `${key.replace(/[_-]+/g, ' ')}${Number(qty) > 1 ? ` x${Number(qty)}` : ''}`)
    return entries.length ? entries.join(', ') : 'None'
  }
  const s = String(v).trim()
  return s.replace(/—/g, ' to ').replace(/–/g, ' to ')
}

export function SpecialRequirementsView({ raw }: { raw: string | Record<string, unknown> | null | undefined }) {
  let parsed: Record<string, unknown> | null = null
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    parsed = raw as Record<string, unknown>
  } else if (typeof raw === 'string') {
    try {
      const trimmed = raw.trim()
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        const candidate = JSON.parse(trimmed)
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
          parsed = candidate as Record<string, unknown>
        }
      }
    } catch {
      parsed = null
    }
  }

  if (!parsed) {
    const text = typeof raw === 'string' ? raw : ''
    if (!text.trim()) return <p className="text-sm text-neutral-400">None provided.</p>
    return (
      <p className="text-sm text-neutral-700 whitespace-pre-wrap">
        {text.replace(/—/g, ' to ').replace(/–/g, ' to ')}
      </p>
    )
  }

  const rows = Object.entries(parsed)
    .filter(([k]) => !HIDDEN_KEYS.has(k))
    .map(([k, v]) => [k, formatValue(k, v)] as const)
    .filter(([, val]) => val.trim().length > 0)

  if (rows.length === 0) {
    return <p className="text-sm text-neutral-400">None provided.</p>
  }

  return (
    <dl className="grid grid-cols-1 sm:grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([k, val]) => (
        <div key={k} className="contents">
          <dt className="text-neutral-500 sm:text-right">{humaniseKey(k)}</dt>
          <dd className="text-neutral-800 whitespace-pre-wrap break-words">{val}</dd>
        </div>
      ))}
    </dl>
  )
}
