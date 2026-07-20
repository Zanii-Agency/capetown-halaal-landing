// Vendor-facing IG Feed Post (1080x1080) PNG download.
//
// Auth: session-gated on the signed-in vendor (CTH-DOCTRINE Law 2). The
// vendor's marketing fields are resolved server-side from
// getExhibitorContext, NEVER from a query/path param.

import { NextResponse } from 'next/server'
import { resolveVendorMarketingFields, vendorFilenameSlug } from '@/lib/marketing/vendor-fields'
import { renderMarketingPng } from '@/lib/marketing/png-renderer'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const fields = await resolveVendorMarketingFields('ig-feed')
  if (!fields) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // ?preview=1 serves the SAME render inline + briefly cacheable, for the
  // portal <img> thumbnail. Without it we serve the attachment download.
  const preview = new URL(req.url).searchParams.get('preview') === '1'
  try {
    const png = await renderMarketingPng('ig-feed', fields)
    const filename = `CTH-IG-Feed-${vendorFilenameSlug(fields.business_name)}.png`
    return new NextResponse(new Uint8Array(png), {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        ...(preview
          ? { 'Cache-Control': 'private, max-age=300' }
          : {
              'Content-Disposition': `attachment; filename="${filename}"`,
              'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
            }),
      },
    })
  } catch (e) {
    console.error('[marketing/ig-feed] render failed:', (e as Error).message)
    return NextResponse.json({ error: 'Could not render asset' }, { status: 500 })
  }
}
