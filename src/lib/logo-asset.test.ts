import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Two assets, two jobs, and swapping either one breaks something real.
//
//   /logo.png       1732x2310 portrait, badge occupies the middle third
//                   (alpha bbox 759x758 = 43.8% w, 32.8% h). The padding is
//                   WANTED here: vendors download this for print.
//   /logo-mark.png  that badge cropped square at 512. For UI chrome.
//
// Rendering logo.png small put 13.1px of artwork in a 40px box on the admin
// sidebar, 13.1px in the portal nav, 9.2px in the announcements avatar, and in
// logo.tsx it was stretched into a square outright because that element sets
// equal width/height with no object-fit and nothing in globals.css constrains
// img aspect. Six surfaces, one root cause.
//
// A source-level guard is the right shape here precisely because the failure is
// a WRONG REFERENCE. There is no runtime behaviour to assert: both files load
// fine and return 200, the image is just the wrong one, which is why this
// survived unnoticed across six surfaces.

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const CHROME = [
  'src/components/logo.tsx',
  'src/components/admin/AdminSidebar.tsx',
  'src/components/exhibitor/PortalNav.tsx',
  'src/app/exhibitor/portal/announcements/page.tsx',
]

// Vendors download the full-bleed original from these. Never point them at the
// mark: it would silently downgrade the brand asset they print with.
const BRAND_ASSET_PAGES = [
  'src/app/exhibitor/portal/resources/page.tsx',
  'src/app/exhibitor/portal/marketing/page.tsx',
]

test('UI chrome renders the cropped mark, never the padded original', () => {
  for (const f of CHROME) {
    const src = read(f)
    assert.match(src, /["']\/logo-mark\.png["']/, `${f} should use the mark`)
    // Only comments may name logo.png in these files.
    const live = src.split('\n').filter((l) => /["']\/logo\.png["']/.test(l))
    assert.deepEqual(live, [], `${f} still renders /logo.png:\n${live.join('\n')}`)
  }
})

test('the vendor brand-asset pages still serve the full padded logo', () => {
  for (const f of BRAND_ASSET_PAGES) {
    const src = read(f)
    assert.match(src, /["']\/logo\.png["']/, `${f} must keep the print-ready original`)
    assert.equal(/logo-mark\.png/.test(src), false, `${f} must NOT hand vendors the cropped mark`)
  }
})

test('the mark exists and is square, or every square box distorts it again', () => {
  const buf = readFileSync(join(process.cwd(), 'public/logo-mark.png'))
  // PNG IHDR: width and height are big-endian uint32 at byte 16 and 20.
  assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG')
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  assert.equal(w, h, `logo-mark.png must be square, got ${w}x${h}`)
  // Big enough for a 65px logo at 3x DPI without softening.
  assert.ok(w >= 256, `logo-mark.png is only ${w}px wide`)
})
