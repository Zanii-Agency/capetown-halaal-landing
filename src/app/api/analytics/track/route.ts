import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isPublicAnalyticsEvent, safeMetadata } from '@/lib/analytics-events'

function parseUA(ua: string) {
  const mobile = /Mobile|Android|iPhone|iPad/i.test(ua)
  const tablet = /iPad|Tablet/i.test(ua)
  const device_type = tablet ? 'tablet' : mobile ? 'mobile' : 'desktop'

  let browser = 'Other'
  if (/Chrome/i.test(ua) && !/Edge|OPR/i.test(ua)) browser = 'Chrome'
  else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari'
  else if (/Firefox/i.test(ua)) browser = 'Firefox'
  else if (/Edge/i.test(ua)) browser = 'Edge'
  else if (/OPR|Opera/i.test(ua)) browser = 'Opera'

  let os = 'Other'
  if (/Windows/i.test(ua)) os = 'Windows'
  else if (/Mac OS/i.test(ua)) os = 'macOS'
  else if (/Linux/i.test(ua)) os = 'Linux'
  else if (/Android/i.test(ua)) os = 'Android'
  else if (/iOS|iPhone|iPad/i.test(ua)) os = 'iOS'

  return { device_type, browser, os }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { type, session_id, path, referrer, metadata, utm_source, utm_medium, utm_campaign } = body

    if (!session_id || !type) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    }

    // THE GATE. This endpoint is unauthenticated and writes with the SERVICE
    // ROLE, and site_events is not an analytics table — it is the project's
    // general event log, which getEftMode() reads the global EFT switch out of.
    // Without this allow-list, POSTing type:"eft_mode" from anywhere on the
    // internet flipped the whole festival's payment lane. See
    // src/lib/analytics-events.ts for the full account.
    if (!isPublicAnalyticsEvent(type)) {
      return NextResponse.json({ error: 'Unsupported event' }, { status: 400 })
    }

    const ua = req.headers.get('user-agent') || ''
    const { device_type, browser, os } = parseUA(ua)

    // Geo from Vercel headers
    const country = req.headers.get('x-vercel-ip-country') || req.headers.get('cf-ipcountry') || null
    const city = req.headers.get('x-vercel-ip-city') || null
    const region = req.headers.get('x-vercel-ip-country-region') || null

    const admin = createAdminClient()

    if (type === 'pageview') {
      const { error } = await admin.from('page_views').insert({
        session_id,
        path: path || '/',
        referrer: referrer || null,
        country,
        city: city ? decodeURIComponent(city) : null,
        region,
        device_type,
        browser,
        os,
        utm_source: utm_source || null,
        utm_medium: utm_medium || null,
        utm_campaign: utm_campaign || null,
      })
      if (error) {
        // Table might not exist yet, fail silently
        console.error('Analytics pageview error:', error.message)
      }
    } else {
      // Custom event
      const { error } = await admin.from('site_events').insert({
        session_id,
        event_type: type,
        path: path || null,
        metadata: safeMetadata(metadata),
      })
      if (error) {
        console.error('Analytics event error:', error.message)
      }
    }

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: true }) // Never break the user experience
  }
}
