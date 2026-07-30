'use client'

/**
 * Shared page chrome for ALL admin + exhibitor portal surfaces.
 * Use these primitives so every page feels like the same product.
 *
 * Palette: ivory + brass + CTH brand-red.
 *   - bg            #FFFFFF
 *   - panel         #FFFFFF
 *   - panel-soft    #FAFAFA
 *   - ink           #1B1A17
 *   - muted         rgba(27,26,23,.55)
 *   - brass         #E5E5E5
 *   - brass-soft    #E5DCC4
 *   - brand-red     #cd2653
 *   - brand-dark    #bf3026
 *
 * Type:
 *   - Headings use font-serif (Fraunces)
 *   - Body uses font-sans (Inter)
 *   - Kickers are small-caps tracking-[0.2em] in brand-red
 *
 * Sizing:
 *   - Page max-width 7xl (1280px), padding 6/8 with sm:px-8 lg:px-10
 *   - Cards rounded-2xl, border with brass at 40% opacity
 *   - Buttons rounded-full for primary CTAs, rounded-lg for secondary
 */

import { type ReactNode } from 'react'

// ---------------- PageShell ----------------
// Wrap every page body. Sets bg + min-h + max-w + padding.
export function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#FFFFFF] text-[#1B1A17]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-10 py-5 sm:py-8">
        {children}
      </div>
    </div>
  )
}

// ---------------- PageHeader ----------------
// Kicker (brand-red small caps) + Fraunces title + optional subtitle + optional actions on the right.
export function PageHeader({
  kicker,
  title,
  subtitle,
  actions,
}: {
  kicker?: string
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-6 sm:mb-8 flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-3 sm:gap-4">
      <div className="flex-1 min-w-0">
        {kicker && (
          <p className="text-xs font-semibold text-[#cd2653] uppercase tracking-[0.22em] mb-2">
            {kicker}
          </p>
        )}
        <h1 className="font-serif text-2xl sm:text-3xl md:text-4xl text-[#1B1A17] leading-tight">{title}</h1>
        {subtitle && (
          <p className="text-sm text-[#1B1A17]/55 mt-2">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  )
}

// ---------------- Card ----------------
// Standard ivory glass card. Use for any rectangular content surface.
export function Card({
  children,
  padded = true,
  className = '',
}: {
  children: ReactNode
  padded?: boolean
  className?: string
}) {
  return (
    <div className={`bg-[#FFFFFF] border border-[#E5E5E5]/40 rounded-2xl ${padded ? 'p-4 sm:p-5 md:p-6' : ''} ${className}`}>
      {children}
    </div>
  )
}

// ---------------- StatCard ----------------
// For top-of-page metric tiles. ONE primary number, supporting context.
export function StatCard({
  label,
  value,
  trend,
  hint,
}: {
  label: string
  value: ReactNode
  trend?: ReactNode
  hint?: ReactNode
}) {
  return (
    <Card>
      <p className="text-[11px] font-semibold text-[#1B1A17]/55 uppercase tracking-[0.18em]">{label}</p>
      <div className="font-serif text-3xl text-[#1B1A17] mt-1 flex items-baseline gap-2">
        {value}
        {trend && <span className="text-xs text-[#1B1A17]/55 font-sans">{trend}</span>}
      </div>
      {hint && <p className="text-[11px] text-[#1B1A17]/50 mt-1">{hint}</p>}
    </Card>
  )
}

// ---------------- Pill ----------------
// Small inline status pill. Use for "live data" / "paid" / "pending" / etc.
export function Pill({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'success' | 'warn' | 'danger' | 'brand'
  children: ReactNode
}) {
  const T: Record<string, string> = {
    neutral: 'bg-[#FFFFFF] border-[#E5E5E5]/40 text-[#1B1A17]/70',
    success: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    warn: 'bg-[#F8DCE3] border-[#cd2653]/30 text-[#cd2653]',
    danger: 'bg-[#cd2653]/10 border-[#cd2653]/40 text-[#bf3026]',
    brand: 'bg-[#cd2653] border-[#cd2653] text-white',
  }
  return (
    <span
      className={`text-[10px] font-bold tracking-[0.14em] uppercase px-2.5 py-1 rounded-full border ${T[tone]}`}
    >
      {children}
    </span>
  )
}

// ---------------- Button ----------------
export function ButtonPrimary({
  children,
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`bg-[#cd2653] hover:bg-[#bf3026] text-white font-semibold rounded-full px-5 py-2.5 text-sm transition-colors disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  )
}
export function ButtonSecondary({
  children,
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`bg-[#FFFFFF] border border-[#E5E5E5]/40 hover:border-[#cd2653]/50 text-[#1B1A17] font-semibold rounded-full px-5 py-2.5 text-sm transition-colors disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  )
}

// ---------------- Tabs ----------------
// Pill tab bar. Active tab = brand-red. Use for horizontal section nav.
export function Tabs({
  items,
  active,
  onChange,
}: {
  items: { k: string; label: string; icon?: ReactNode }[]
  active: string
  onChange: (k: string) => void
}) {
  return (
    <div className="inline-flex flex-wrap gap-1 bg-[#FFFFFF] border border-[#E5E5E5]/40 rounded-full p-1 mb-6">
      {items.map((t) => {
        const isActive = t.k === active
        return (
          <button
            key={t.k}
            onClick={() => onChange(t.k)}
            className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors flex items-center gap-2 ${
              isActive ? 'bg-[#cd2653] text-white' : 'text-[#1B1A17]/65 hover:text-[#1B1A17]'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

// ---------------- DataTable ----------------
// Ivory + brass styled table. For listings.
export function DataTable({
  columns,
  rows,
  emptyLabel = 'Nothing here yet.',
}: {
  columns: { key: string; label: string; align?: 'left' | 'right' | 'center'; render?: (row: Record<string, unknown>) => ReactNode }[]
  rows: Record<string, unknown>[]
  emptyLabel?: string
}) {
  return (
    <Card padded={false} className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-[0.14em] text-[#1B1A17]/55 border-b border-[#E5E5E5]/30 bg-[#FFFFFF]/40">
              {columns.map((c) => (
                <th key={c.key} className={`p-3 font-bold ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : ''}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="p-8 text-center text-[#1B1A17]/45 text-sm">{emptyLabel}</td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-[#E5E5E5]/15 last:border-b-0">
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`p-3 ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : ''}`}
                  >
                    {c.render ? c.render(r) : (r[c.key] as ReactNode)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// ---------------- KV ----------------
// Compact key-value row, brass divider. Use in detail panels.
export function KV({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-2.5 border-b border-[#E5E5E5]/15 last:border-b-0 text-sm">
      <span className="text-[#1B1A17]/55">{label}</span>
      <span className="text-right text-[#1B1A17]">{value}</span>
    </div>
  )
}

// ---------------- Empty ----------------
// Empty state. Use when a list has no rows but the page is OK.
export function Empty({
  title,
  hint,
  cta,
}: {
  title: string
  hint?: string
  cta?: ReactNode
}) {
  return (
    <Card className="text-center py-10">
      <p className="font-serif text-xl text-[#1B1A17]">{title}</p>
      {hint && <p className="text-sm text-[#1B1A17]/55 mt-2">{hint}</p>}
      {cta && <div className="mt-4">{cta}</div>}
    </Card>
  )
}

// ---------------- Design System Foundation (Agent 1) ----------------
export { KpiStrip } from './KpiStrip'
export { Kpi } from './Kpi'
export { DenseTable } from './DenseTable'
export { StatusPill } from './StatusPill'
export { FilterPillRow } from './FilterPillRow'
export { FilterPill } from './FilterPill'
export { ActionChipGrid } from './ActionChipGrid'
export { ActionChip } from './ActionChip'
export { RightDrawer } from './RightDrawer'
