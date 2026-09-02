// Returns counts of approved vendors per sector slug, for the homepage
// SectorsSection badges. Public read, cached lightly.

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isPublicVendor } from '@/lib/public-vendor'

export const dynamic = 'force-dynamic'

const SLUG_TO_SECTOR: Record<string, string> = {
  'food-beverage': 'Food & Beverage',
  'fashion-modest-wear': 'Fashion & Modest Wear',
  'beauty-wellness': 'Beauty & Wellness',
  'health-pharmacy': 'Health & Pharmacy',
  'travel-tourism': 'Travel & Tourism',
  'home-living': 'Home & Living',
  'finance-services': 'Finance & Services',
  'business-trade': 'Business & Trade',
}

export async function GET() {
  const admin = createAdminClient()
  const { data } = await admin
    .from('vendor_applications')
    .select('product_categories, admin_notes, paid_at')
    .eq('status', 'approved')

  const rows = (data || []).filter((r) =>
    isPublicVendor({ admin_notes: r.admin_notes as string | null, paid_at: r.paid_at as string | null }),
  )

  const counts: Record<string, number> = {}
  for (const slug of Object.keys(SLUG_TO_SECTOR)) counts[slug] = 0

  for (const row of rows) {
    const cats = Array.isArray(row.product_categories) ? (row.product_categories as string[]) : []
    for (const [slug, name] of Object.entries(SLUG_TO_SECTOR)) {
      if (cats.includes(name)) counts[slug]++
    }
  }

  const total = rows.length
  return NextResponse.json(
    { counts, total },
    { headers: { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300' } }
  )
}
