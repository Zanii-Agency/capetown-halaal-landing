import sanitizeHtml from 'sanitize-html'

/**
 * Strip ALL HTML tags from input. Returns plain-text only.
 *
 * Public vendor profile fields (description, menu[].desc, business_description)
 * are rendered onto /sectors/[slug]/[vendor] which is a public surface. CSP is
 * Report-Only here, so any unsanitized HTML/JS would actually execute. We do
 * not allow any tag, attribute, or scheme through.
 */
export function stripAllHtml(input: string): string {
  if (!input) return ''
  return sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: 'discard',
  })
}

// Widened 2026-07-26 for the "clean reading view" (Taona: emails should read
// natively, like Gmail). The old allowlist was a, p, br, strong, em, ul, ol, li,
// blockquote, hr — no div, span or table, which is what real mail is built from.
// A structured email collapsed into bare text, which is a large part of why the
// inbox read as "wrongly formatted and hard to read".
//
// The shape of the fix is LAYOUT IN, TYPOGRAPHY OUT: allow the tags and the
// styles that carry structure, drop the ones that carry the sender's type
// choices, and restyle everything to our own scale in the .email-body block in
// globals.css. That is what makes a hundred senders' mail read as one inbox.
const EMAIL_ALLOWED_TAGS = [
  'a', 'p', 'br', 'div', 'span', 'hr', 'pre', 'code', 'blockquote',
  'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'sub', 'sup', 'small', 'mark',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
]

const HEX_OR_RGB = [/^#[0-9a-fA-F]{3,8}$/, /^rgba?\(\s*[\d\s,.%]+\)$/]
const LEN = /^[\d.]+(px|em|rem|%)$/
const BOX = /^[\d.]+(px|em|rem|%)( +[\d.]+(px|em|rem|%)){0,3}$/

/**
 * Sanitize inbound email HTML for the operator-only inbox.
 *
 * Still explicitly disallowed: script, iframe, style, link, meta, form, input,
 * object, embed, video, audio, svg, base — and **img**.
 *
 * `img` stays off the list deliberately, and it is the whole answer to remote
 * images and tracking pixels: no proxy, no CSP work, no broken-image icons, and
 * none of the 1x1 pixels marketing mail is full of. Genuine attachments (and
 * inline cid: images, which mailparser hands us as attachments) already reach
 * the operator through the `media[]` array on the same origin.
 *
 * Styles are filtered to layout + emphasis only. NOT allowed: font-family and
 * font-size (we restyle to our own typography — this is the single biggest fix
 * for "wrongly formatted"), and position/display/float/z-index, which can paint
 * over our own chrome.
 *
 * Example: `<script>alert(1)</script><p>hello <a href="http://x">link</a></p>`
 *   becomes `<p>hello <a href="http://x" target="_blank" rel="noopener noreferrer">link</a></p>`.
 */
export function sanitizeEmailHtml(input: string): string {
  if (!input) return ''
  return sanitizeHtml(input, {
    allowedTags: EMAIL_ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'target', 'rel', 'title'],
      td: ['colspan', 'rowspan', 'align', 'valign'],
      th: ['colspan', 'rowspan', 'align', 'valign', 'scope'],
      table: ['align'],
      col: ['span'],
      '*': ['style', 'align', 'dir'],
    },
    allowedStyles: {
      '*': {
        'text-align': [/^(left|right|center|justify)$/],
        'font-weight': [/^(normal|bold|[1-9]00)$/],
        'font-style': [/^(normal|italic)$/],
        'text-decoration': [/^(none|underline|line-through)$/],
        color: HEX_OR_RGB,
        'background-color': HEX_OR_RGB,
        padding: [BOX], 'padding-left': [LEN], 'padding-top': [LEN],
        'padding-right': [LEN], 'padding-bottom': [LEN],
        margin: [BOX], 'margin-left': [LEN], 'margin-top': [LEN],
        'margin-right': [LEN], 'margin-bottom': [LEN],
        'border-collapse': [/^(collapse|separate)$/],
        width: [/^(auto|[\d.]+(px|%|em|rem))$/],
        'vertical-align': [/^(top|middle|bottom|baseline)$/],
      },
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesAppliedToAttributes: ['href'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      // Force every anchor to open in a new tab with noopener noreferrer. This
      // is defense-in-depth in case CSP is Report-Only on /admin.
      a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }, true),
    },
  })
}
