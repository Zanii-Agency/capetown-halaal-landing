'use client'

import { useState, useRef } from 'react'
import { Loader2, Upload, Plus, Trash2, Check, Globe, Instagram, Facebook, Sparkles, ExternalLink, CheckCircle2, AlertCircle, Image as ImageIcon, X } from 'lucide-react'
import { prepareUploadFile, FileTooLargeError, tooLargeMessage } from '@/lib/client/prepare-upload'

interface Menu { name: string; price?: string; desc?: string }
interface GalleryPhoto { path: string; url: string }
interface Profile {
  business_name: string
  tagline: string
  description: string
  website: string
  instagram: string
  facebook: string
  menu: Menu[]
  logo_url: string | null
  gallery_urls: GalleryPhoto[]
  sector: string | null
}
interface Publication {
  is_live: boolean
  is_approved: boolean
  has_logo: boolean
  has_write_up: boolean
  live_url: string | null
  preview_url: string | null
}

// 5 starter write-up templates. Vendor picks one to pre-fill the textarea,
// then edits freely. Each is ~80-120 words — under the 200-word soft cap.
const WRITE_UP_TEMPLATES: Array<{ label: string; body: string }> = [
  {
    label: 'Family business',
    body: 'We are a family business that has been bringing authentic flavours to Cape Town for years. Every dish we serve is made with care, using recipes passed down through generations. Come visit our stall to taste the food we grew up with, and meet the family behind every plate.',
  },
  {
    label: 'Specialist craft',
    body: 'We specialise in one thing and we do it properly. Years of practice have gone into perfecting our craft, and every item on our menu reflects that focus. If you appreciate attention to detail and quality ingredients, our stall is where you want to be.',
  },
  {
    label: 'New brand launch',
    body: 'Young at Heart Festival 2026 is the first chance to taste what we have been quietly building. Our menu is small, intentional, and made fresh on site. Stop by, say hello, and be among the first to try something new in the Cape Town food scene.',
  },
  {
    label: 'Halaal-first',
    body: 'Every ingredient we use is strictly halaal-certified and traceable. We take this seriously: our suppliers are vetted, our preparation is segregated, and our certificates are on display at our stall. Eat with confidence, and bring the whole family.',
  },
  {
    label: 'Start blank',
    body: '',
  },
]

const SECTOR_TO_SLUG: Record<string, string> = {
  'Food & Beverage': 'food-beverage',
  'Fashion & Modest Wear': 'fashion-modest-wear',
  'Beauty & Wellness': 'beauty-wellness',
  'Health & Pharmacy': 'health-pharmacy',
  'Travel & Tourism': 'travel-tourism',
  'Home & Living': 'home-living',
  'Finance & Services': 'finance-services',
  'Business & Trade': 'business-trade',
}

const SOFT_CAP_WORDS = 200
const HARD_CAP_WORDS = 350

function countWords(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0
}

export default function ProfileEditor({
  initial,
  publication,
}: {
  initial: Profile
  publication: Publication
}) {
  const [p, setP] = useState<Profile>(initial)
  const [pub, setPub] = useState<Publication>(publication)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [uploading, setUploading] = useState<'logo' | 'gallery' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [templateOpen, setTemplateOpen] = useState(false)
  const logoInput = useRef<HTMLInputElement>(null)
  const galleryInput = useRef<HTMLInputElement>(null)

  function set<K extends keyof Profile>(k: K, v: Profile[K]) {
    setP((prev) => ({ ...prev, [k]: v }))
  }
  function setMenu(i: number, k: keyof Menu, v: string) {
    setP((prev) => ({ ...prev, menu: prev.menu.map((m, j) => (j === i ? { ...m, [k]: v } : m)) }))
  }

  // Re-derive publication signals locally so badges flip immediately without a refetch.
  function recomputePublication(next: Profile) {
    const hasLogo = Boolean(next.logo_url)
    const hasWriteUp = Boolean(next.description.trim())
    setPub((prev) => ({
      ...prev,
      has_logo: hasLogo,
      has_write_up: hasWriteUp,
      is_live: prev.is_approved && hasLogo && hasWriteUp,
      live_url: prev.is_approved && hasLogo && hasWriteUp ? prev.preview_url : null,
    }))
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/exhibitor/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tagline: p.tagline,
          description: p.description,
          website: p.website,
          instagram: p.instagram,
          facebook: p.facebook,
          menu: p.menu,
        }),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed')
      setSavedAt(Date.now())
      recomputePublication(p)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function uploadLogo(file: File) {
    setUploading('logo')
    setError(null)
    try {
      // Compress oversized images under Vercel's ~4.5MB body cap. Without this a
      // phone-sized logo 413s BEFORE the route runs, logo_path never saves, and the
      // vendor is re-nagged forever while believing they uploaded it (Elegant
      // Muslimah, 2026-09-04). Small logos pass through untouched (transparency
      // kept). Same fix already on DocumentsManager / EftPanel.
      const toSend = await prepareUploadFile(file)
      const fd = new FormData()
      fd.append('logo', toSend)
      const res = await fetch('/api/exhibitor/profile', { method: 'POST', body: fd })
      if (res.status === 413) throw new Error(tooLargeMessage(toSend.size))
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || 'Upload failed')
      const next = { ...p, logo_url: j.logo_url as string }
      setP(next)
      recomputePublication(next)
    } catch (e) {
      if (e instanceof FileTooLargeError) setError(e.message)
      else setError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(null)
    }
  }

  async function uploadGalleryPhoto(file: File) {
    setUploading('gallery')
    setError(null)
    try {
      const toSend = await prepareUploadFile(file)
      const fd = new FormData()
      fd.append('gallery', toSend)
      const res = await fetch('/api/exhibitor/profile', { method: 'POST', body: fd })
      if (res.status === 413) throw new Error(tooLargeMessage(toSend.size))
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || 'Upload failed')
      const next = { ...p, gallery_urls: [...p.gallery_urls, { path: j.path, url: j.url }] }
      setP(next)
    } catch (e) {
      if (e instanceof FileTooLargeError) setError(e.message)
      else setError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(null)
      if (galleryInput.current) galleryInput.current.value = ''
    }
  }

  async function removeGalleryPhoto(path: string) {
    setError(null)
    const prev = p.gallery_urls
    setP({ ...p, gallery_urls: prev.filter((g) => g.path !== path) })
    try {
      const res = await fetch('/api/exhibitor/profile', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gallery_path: path }),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'Remove failed')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Remove failed')
      setP({ ...p, gallery_urls: prev }) // revert on failure
    }
  }

  const wordCount = countWords(p.description)
  const wordsRed = wordCount > HARD_CAP_WORDS
  const wordsAmber = wordCount > SOFT_CAP_WORDS && wordCount <= HARD_CAP_WORDS

  const field = 'w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-[#cd2653]'
  const sectorSlug = p.sector ? SECTOR_TO_SLUG[p.sector] : null

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" /> {error}
        </div>
      )}

      {/* Publication status banner */}
      <div className={`rounded-2xl border p-4 ${pub.is_live ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
        <div className="flex items-start gap-3">
          {pub.is_live ? (
            <CheckCircle2 className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
          ) : (
            <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            {pub.is_live ? (
              <>
                <p className="text-sm font-semibold text-green-900">Your profile is LIVE</p>
                <p className="text-xs text-green-700 mt-0.5">
                  Festival-goers can see your stall at:
                </p>
                {pub.live_url && (
                  <a href={pub.live_url} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 mt-1 text-sm font-medium text-green-800 hover:underline break-all">
                    {pub.live_url.replace('https://', '')}
                    <ExternalLink className="w-3 h-3 flex-shrink-0" />
                  </a>
                )}
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-amber-900">Profile not yet live</p>
                <ul className="text-xs text-amber-800 mt-1.5 space-y-1">
                  <li className="flex items-center gap-1.5">
                    {pub.is_approved ? <CheckCircle2 className="w-3 h-3 text-green-600" /> : <X className="w-3 h-3 text-amber-700" />}
                    Application approved
                  </li>
                  <li className="flex items-center gap-1.5">
                    {pub.has_logo ? <CheckCircle2 className="w-3 h-3 text-green-600" /> : <X className="w-3 h-3 text-amber-700" />}
                    Logo uploaded
                  </li>
                  <li className="flex items-center gap-1.5">
                    {pub.has_write_up ? <CheckCircle2 className="w-3 h-3 text-green-600" /> : <X className="w-3 h-3 text-amber-700" />}
                    Write-up filled in
                  </li>
                </ul>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Sector lock + identity */}
      <div className="bg-white border border-neutral-200 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <p className="font-semibold text-neutral-900">Your listing</p>
          {p.sector && sectorSlug && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-neutral-600 bg-neutral-100 rounded-full px-3 py-1">
              {p.sector}
            </span>
          )}
        </div>

        {/* Logo */}
        <div className="flex items-center gap-4 mb-5">
          <div className="w-24 h-24 rounded-xl bg-neutral-100 overflow-hidden flex items-center justify-center shrink-0 border border-neutral-200">
            {p.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.logo_url} alt="logo" className="w-full h-full object-contain" />
            ) : (
              <ImageIcon className="w-8 h-8 text-neutral-300" />
            )}
          </div>
          <div className="flex-1">
            <input
              ref={logoInput}
              type="file"
              accept=".png,.jpg,.jpeg,.webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) uploadLogo(f)
              }}
            />
            <button
              onClick={() => logoInput.current?.click()}
              disabled={uploading === 'logo'}
              className="flex items-center gap-1.5 text-sm font-medium rounded-lg px-3 py-2 border border-neutral-200 hover:border-[#cd2653] hover:text-[#cd2653] disabled:opacity-60"
            >
              {uploading === 'logo' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {p.logo_url ? 'Replace logo' : 'Upload logo'}
            </button>
            <p className="text-xs text-neutral-500 mt-1.5">
              <strong>Format:</strong> PNG, JPG, or WebP. Square ratio (800×800px ideal). Max 5MB.
              Transparent PNG works best.
            </p>
          </div>
        </div>

        {/* Tagline */}
        <label className="text-xs font-semibold text-neutral-600">Tagline</label>
        <input
          value={p.tagline}
          onChange={(e) => set('tagline', e.target.value)}
          placeholder="e.g. Authentic Cape Malay street food"
          className={`${field} mt-1 mb-1`}
          maxLength={120}
        />
        <p className="text-xs text-neutral-400 mb-4">One short line shown under your name. Max 120 characters.</p>

        {/* Write-up with templates */}
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs font-semibold text-neutral-600">About your business</label>
          <button
            onClick={() => setTemplateOpen(!templateOpen)}
            className="text-xs text-[#cd2653] font-medium flex items-center gap-1 hover:underline"
          >
            <Sparkles className="w-3 h-3" /> Use a starter template
          </button>
        </div>
        {templateOpen && (
          <div className="mb-3 p-3 bg-neutral-50 border border-neutral-200 rounded-lg">
            <p className="text-xs text-neutral-600 mb-2">
              Pick one, then edit it to make it yours. Vendors who write their own get better engagement.
            </p>
            <div className="flex flex-wrap gap-2">
              {WRITE_UP_TEMPLATES.map((t) => (
                <button
                  key={t.label}
                  onClick={() => {
                    set('description', t.body)
                    setTemplateOpen(false)
                  }}
                  className="text-xs font-medium px-3 py-1.5 rounded-full border border-neutral-200 bg-white hover:border-[#cd2653] hover:text-[#cd2653]"
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        )}
        <textarea
          value={p.description}
          onChange={(e) => set('description', e.target.value)}
          rows={6}
          placeholder="A short paragraph or two introducing your stall to festival-goers."
          className={`${field}`}
          maxLength={2200}
        />
        <div className="flex items-center justify-between mt-1.5">
          <p className="text-xs text-neutral-400">
            Tip: lead with what you do, then who you are.
          </p>
          <p className={`text-xs font-medium ${wordsRed ? 'text-red-600' : wordsAmber ? 'text-amber-600' : 'text-neutral-500'}`}>
            {wordCount} / {SOFT_CAP_WORDS} words
            {wordsRed ? ` (hard cap ${HARD_CAP_WORDS})` : ''}
          </p>
        </div>
      </div>

      {/* Socials */}
      <div className="bg-white border border-neutral-200 rounded-2xl p-5 grid sm:grid-cols-3 gap-3">
        <div>
          <label className="text-xs font-semibold text-neutral-600 flex items-center gap-1"><Globe className="w-3 h-3" /> Website</label>
          <input value={p.website} onChange={(e) => set('website', e.target.value)} placeholder="https://" className={`${field} mt-1`} />
        </div>
        <div>
          <label className="text-xs font-semibold text-neutral-600 flex items-center gap-1"><Instagram className="w-3 h-3" /> Instagram</label>
          <input value={p.instagram} onChange={(e) => set('instagram', e.target.value)} placeholder="@handle" className={`${field} mt-1`} />
        </div>
        <div>
          <label className="text-xs font-semibold text-neutral-600 flex items-center gap-1"><Facebook className="w-3 h-3" /> Facebook</label>
          <input value={p.facebook} onChange={(e) => set('facebook', e.target.value)} placeholder="facebook.com/…" className={`${field} mt-1`} />
        </div>
      </div>

      {/* Menu / products */}
      <div className="bg-white border border-neutral-200 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-2">
          <p className="font-semibold text-neutral-900">
            {p.sector === 'Food & Beverage' ? 'Menu items' : 'What you bring'}
          </p>
          <button onClick={() => set('menu', [...p.menu, { name: '', price: '', desc: '' }])}
            className="flex items-center gap-1 text-sm font-medium text-[#cd2653]">
            <Plus className="w-4 h-4" /> Add item
          </button>
        </div>
        <p className="text-xs text-neutral-500 mb-3">
          Up to 40 items. Each shows on your public profile.
        </p>
        {p.menu.length === 0 ? (
          <p className="text-sm text-neutral-500 italic">No items yet. Add what you&apos;ll be selling.</p>
        ) : (
          <div className="space-y-2">
            {p.menu.map((m, i) => (
              <div key={i} className="grid grid-cols-[1.3fr_0.6fr_1.6fr_auto] gap-2 items-center">
                <input value={m.name} onChange={(e) => setMenu(i, 'name', e.target.value)} placeholder="Item" className={field} />
                <input value={m.price || ''} onChange={(e) => setMenu(i, 'price', e.target.value)} placeholder="R50" className={field} />
                <input value={m.desc || ''} onChange={(e) => setMenu(i, 'desc', e.target.value)} placeholder="Short description" className={field} />
                <button onClick={() => set('menu', p.menu.filter((_, j) => j !== i))}
                  className="text-neutral-400 hover:text-red-600 p-1.5" aria-label="Remove">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Gallery */}
      <div className="bg-white border border-neutral-200 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-2">
          <p className="font-semibold text-neutral-900">Photo gallery</p>
          <span className="text-xs text-neutral-500">{p.gallery_urls.length} / 8</span>
        </div>
        <p className="text-xs text-neutral-500 mb-3">
          <strong>Format:</strong> PNG, JPG, or WebP. Landscape works best (1200×800px ideal). Max 8MB each, up to 8 photos.
        </p>

        {p.gallery_urls.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
            {p.gallery_urls.map((g) => (
              <div key={g.path} className="relative aspect-[4/3] rounded-lg overflow-hidden bg-neutral-100 group">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={g.url} alt="gallery" className="w-full h-full object-cover" />
                <button
                  onClick={() => removeGalleryPhoto(g.path)}
                  className="absolute top-1.5 right-1.5 bg-white/90 hover:bg-white text-neutral-700 hover:text-red-600 rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label="Remove photo"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {p.gallery_urls.length < 8 && (
          <>
            <input
              ref={galleryInput}
              type="file"
              accept=".png,.jpg,.jpeg,.webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) uploadGalleryPhoto(f)
              }}
            />
            <button
              onClick={() => galleryInput.current?.click()}
              disabled={uploading === 'gallery'}
              className="flex items-center gap-1.5 text-sm font-medium rounded-lg px-3 py-2 border border-neutral-200 hover:border-[#cd2653] hover:text-[#cd2653] disabled:opacity-60"
            >
              {uploading === 'gallery' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              Add photo
            </button>
          </>
        )}
      </div>

      {/* Save */}
      <div className="flex items-center gap-3 sticky bottom-0 bg-white/95 backdrop-blur border border-neutral-200 rounded-2xl p-4 shadow-sm">
        <button
          onClick={save}
          disabled={saving}
          className="bg-[#cd2653] hover:bg-[#b01f45] text-white font-semibold rounded-lg px-5 py-2.5 text-sm flex items-center gap-2 disabled:opacity-60"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          Save profile
        </button>
        {savedAt && <span className="text-sm text-green-600">Saved</span>}
        {pub.preview_url && (
          <a
            href={pub.preview_url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-sm text-neutral-600 hover:text-neutral-900 flex items-center gap-1.5"
          >
            Preview my profile <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
      </div>
    </div>
  )
}
