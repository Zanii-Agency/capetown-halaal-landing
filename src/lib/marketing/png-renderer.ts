// Shared Puppeteer renderer for per-vendor marketing PNGs.
//
// Mirrors the pattern in src/lib/payments/invoice-pdf.ts (puppeteer-core +
// @sparticuz/chromium-min) but renders an exact-dimension PNG screenshot
// instead of a PDF. One browser instance is cached across requests inside
// the same lambda warm container so we do not re-extract the chromium
// archive on every render (cold-start cost dominates otherwise).
//
// CTH-DOCTRINE Law 7 (no em-dashes) applies to every template that calls
// this. The renderer itself only handles transport.
//
// Auth/PII: this module never sees a session. Callers (the route handlers)
// resolve the vendor's data via getExhibitorContext FIRST, then pass already
// HTML-escaped, vendor-scoped fields in. There is no path here that takes
// a vendor id from a query parameter.
//
// Templates live under src/templates/marketing/*.html and use double-brace
// {{placeholder}} tokens. We use replaceAll (not a regex) to inject values.

import fs from 'node:fs/promises'
import path from 'node:path'
import type { Browser } from 'puppeteer-core'

// Public CDN path for the @sparticuz/chromium binary, version-pinned to match
// what invoice-pdf.ts already uses. Keep these in sync if upgrading.
const CHROMIUM_PACK_URL =
  'https://github.com/Sparticuz/chromium/releases/download/v147.0.0/chromium-v147.0.0-pack.x64.tar'

// Module-level cache. Lambda containers warm-start across renders within a
// few minutes, so amortising the chromium extract and the puppeteer.launch
// is a big win. We null it out on disconnect so the next call relaunches.
let cachedBrowser: Browser | null = null

async function getBrowser(): Promise<Browser> {
  if (cachedBrowser && cachedBrowser.connected) return cachedBrowser
  const chromium = (await import('@sparticuz/chromium-min')).default
  const puppeteer = (await import('puppeteer-core')).default
  const executablePath = await chromium.executablePath(CHROMIUM_PACK_URL)
  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath,
    headless: true,
  })
  browser.on('disconnected', () => {
    if (cachedBrowser === browser) cachedBrowser = null
  })
  cachedBrowser = browser
  return browser
}

export type MarketingTemplate = 'ig-story' | 'ig-feed' | 'fb-post' | 'link-card'

// Exact pixel dimensions per template. The screenshot is taken at this
// viewport so the PNG comes out at exactly this size for upload.
export const TEMPLATE_DIMENSIONS: Record<MarketingTemplate, { width: number; height: number }> = {
  'ig-story': { width: 1080, height: 1920 },
  'ig-feed':  { width: 1080, height: 1080 },
  'fb-post':  { width: 1200, height: 630 },
  'link-card': { width: 1200, height: 630 },
}

/**
 * Replace {{placeholder}} tokens in a template string. Uses String.replaceAll
 * (Node 16+, which this codebase already targets) so there is no regex
 * escaping risk on user-supplied values. Values must already be HTML-safe.
 */
function injectTokens(template: string, values: Record<string, string>): string {
  let out = template
  for (const [k, v] of Object.entries(values)) {
    out = out.replaceAll(`{{${k}}}`, v)
  }
  return out
}

/** Escape a string for safe interpolation into HTML text/attributes. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c] as string))
}

const TEMPLATE_DIR = path.join(process.cwd(), 'src', 'templates', 'marketing')

async function loadTemplate(name: MarketingTemplate): Promise<string> {
  const p = path.join(TEMPLATE_DIR, `${name}.html`)
  return fs.readFile(p, 'utf8')
}

/**
 * Render a marketing template to a PNG buffer at the template's exact
 * dimensions. Throws on failure so the route handler can surface a clean 500.
 */
export async function renderMarketingPng(
  template: MarketingTemplate,
  values: Record<string, string>,
): Promise<Buffer> {
  const dims = TEMPLATE_DIMENSIONS[template]
  const html = injectTokens(await loadTemplate(template), values)

  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
    // deviceScaleFactor MUST stay 1: a >1 factor multiplies the rendered
    // surface area (e.g. 2x => 4x the pixels) which is what pushes the tall
    // ig-story canvas (1080x1920) into the lambda's OOM ceiling.
    await page.setViewport({ width: dims.width, height: dims.height, deviceScaleFactor: 1 })
    await page.setContent(html, { waitUntil: 'load' })
    // 'load' can fire before remote images (the network logo) finish painting,
    // which produced the occasional blank/half-rendered PNG. Explicitly wait for
    // any in-flight images to settle. Time-boxed + guarded so a slow/broken
    // asset can never hang the render.
    try {
      await page.evaluate(
        () =>
          Promise.race([
            Promise.all(
              Array.from(document.images)
                .filter((img) => !img.complete)
                .map(
                  (img) =>
                    new Promise<void>((resolve) => {
                      // addEventListener (not img.onload=) so inline onload/
                      // onerror handlers in the template markup are preserved.
                      img.addEventListener('load', () => resolve())
                      img.addEventListener('error', () => resolve())
                    }),
                ),
            ).then(() => undefined),
            new Promise<void>((resolve) => setTimeout(resolve, 3000)),
          ]),
      )
    } catch {
      // image wait unsupported or rejected; proceed with whatever painted.
    }
    // Belt-and-braces: explicitly wait for web fonts (Google Fonts) to finish
    // loading so headings render in Fraunces/Inter rather than a fallback.
    // Guarded + time-boxed so a font CDN hiccup can never hang the render.
    try {
      await page.evaluate(
        () =>
          (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready ??
          Promise.resolve(),
      )
    } catch {
      // document.fonts unsupported or rejected; proceed with whatever painted.
    }
    const buf = await page.screenshot({
      type: 'png',
      omitBackground: false,
      clip: { x: 0, y: 0, width: dims.width, height: dims.height },
    })
    return Buffer.from(buf)
  } catch (e) {
    // Verbose, self-diagnosing server log. The route catch flattens this to a
    // generic 34-byte 500 for the client, so this is the ONLY place the real
    // chromium failure (OOM vs timeout vs render exception) is captured in the
    // Vercel function logs. Include template + dimensions so a future failure
    // names exactly which canvas blew up (ig-story is the tall 1080x1920 one).
    const err = e as Error
    console.error(
      `[marketing-png] render failed: template=${template} ` +
        `dims=${dims.width}x${dims.height} message=${err?.message}`,
    )
    console.error('[marketing-png] stack:', err?.stack)
    throw e
  } finally {
    await page.close()
  }
}
