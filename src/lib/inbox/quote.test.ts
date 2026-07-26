// The risk: cutting too eagerly hides the actual message. Every assertion here
// is really "did we keep what the person wrote".
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { splitQuotedText, splitQuotedHtml } from './quote'

test('splitQuotedText cuts at the client markers, keeping the reply', () => {
  const gmail = 'Yes Saturday works.\n\nOn Mon, 21 Jul 2026 at 09:14, Support <s@x.co> wrote:\n> original\n> more'
  const g = splitQuotedText(gmail)
  assert.equal(g.visible, 'Yes Saturday works.')
  assert.match(g.quoted!, /^On Mon/)

  const outlook = 'Confirmed.\n\n-----Original Message-----\nFrom: Support\nblah'
  assert.equal(splitQuotedText(outlook).visible, 'Confirmed.')

  const rule = 'Thanks!\n\n________________________\nFrom: Support'
  assert.equal(splitQuotedText(rule).visible, 'Thanks!')

  const hdr = 'See below.\n\nFrom: Support <s@x.co>\nSent: Monday\nSubject: Re'
  assert.equal(splitQuotedText(hdr).visible, 'See below.')

  const sig = 'Please confirm.\n\n--\nSamreen\nYoung at Heart'
  assert.equal(splitQuotedText(sig).visible, 'Please confirm.')
})

test('splitQuotedText only cuts a > run when the WHOLE tail is quoted', () => {
  // Trailing quote — safe to cut.
  const trailing = 'My answer.\n\n> their question\n> second line'
  assert.equal(splitQuotedText(trailing).visible, 'My answer.')

  // Inline quote with the sender's own reply BELOW it. Cutting here would hide
  // the actual message, so the whole body must survive.
  const inline = 'Re your point:\n\n> you said this\n\nAnd my answer is yes.'
  const r = splitQuotedText(inline)
  assert.equal(r.quoted, null)
  assert.match(r.visible, /And my answer is yes\./)
})

test('splitQuotedText never returns an empty visible half', () => {
  // A body that is nothing but quote: show it rather than an empty bubble.
  const allQuote = '> only quoted text\n> nothing of my own'
  const r = splitQuotedText(allQuote)
  assert.equal(r.visible, allQuote)
  assert.equal(r.quoted, null)

  assert.deepEqual(splitQuotedText(''), { visible: '', quoted: null })
  assert.deepEqual(splitQuotedText(null), { visible: '', quoted: null })
  // No markers at all — untouched.
  assert.deepEqual(splitQuotedText('Just a plain message.'), { visible: 'Just a plain message.', quoted: null })
})

test('splitQuotedHtml cuts at the real clients containers', () => {
  const gmail = '<p>Sure thing.</p><div class="gmail_quote"><blockquote>old</blockquote></div>'
  const g = splitQuotedHtml(gmail)
  assert.equal(g.visible, '<p>Sure thing.</p>')
  assert.match(g.quoted!, /gmail_quote/)

  const apple = '<p>Confirmed.</p><blockquote type="cite">old thread</blockquote>'
  assert.equal(splitQuotedHtml(apple).visible, '<p>Confirmed.</p>')

  const outlook = '<p>Noted.</p><div id="appendonsend"></div><div>history</div>'
  assert.equal(splitQuotedHtml(outlook).visible, '<p>Noted.</p>')

  // Case-insensitive: real mail is not consistent about attribute casing.
  const upper = '<p>Hi.</p><DIV CLASS="gmail_quote">old</DIV>'
  assert.equal(splitQuotedHtml(upper).visible, '<p>Hi.</p>')
})

test('splitQuotedHtml keeps a forward that has no added comment', () => {
  // Everything before the marker is markup with no text — the quote IS the
  // message, so showing only the wrapper would render a blank card.
  const bare = '<div><br></div><div class="gmail_quote"><p>the forwarded thing</p></div>'
  const r = splitQuotedHtml(bare)
  assert.equal(r.quoted, null)
  assert.match(r.visible, /the forwarded thing/)

  assert.deepEqual(splitQuotedHtml(''), { visible: '', quoted: null })
  assert.deepEqual(splitQuotedHtml(null), { visible: '', quoted: null })
})
