import { Search } from 'lucide-react'

// zanii-codef: plain GET form, server filters on ?q=. No client JS needed.
export function VendorSearch({ q, hidden }: { q: string; hidden?: Record<string, string> }) {
  return (
    <form method="get" className="relative mb-4 max-w-sm">
      {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
      <input
        type="search"
        name="q"
        defaultValue={q}
        placeholder="Search vendor, contact name"
        className="w-full rounded-lg border border-neutral-200 bg-white pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-[#cd2653]"
      />
    </form>
  )
}

export function matchesVendor(q: string, ...fields: Array<string | null | undefined>) {
  const n = q.trim().toLowerCase()
  return !n || fields.some((f) => f?.toLowerCase().includes(n))
}
