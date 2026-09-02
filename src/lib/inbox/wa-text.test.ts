// The risk here is OVER-matching: mangling a price, an arithmetic expression or
// a snake_case identifier that a vendor typed literally. WhatsApp itself only
// formats a delimiter that is not surrounded by word characters, and these
// assertions are mostly about honouring that.
//
// Asserting on rendered structure rather than an HTML string, since renderWaText
// deliberately returns ReactNode[] (never dangerouslySetInnerHTML).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReactElement } from 'react'

import { renderWaText } from './wa-text'

/** Flatten the node tree to the tags used, in order. */
function tags(nodes: unknown[]): string[] {
  const out: string[] = []
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk)
    if (n && typeof n === 'object' && 'type' in (n as ReactElement)) {
      const el = n as ReactElement<{ children?: unknown }>
      if (typeof el.type === 'string') out.push(el.type)
      walk(el.props?.children)
    }
  }
  nodes.forEach(walk)
  return out
}

/** Flatten to visible text. */
function text(nodes: unknown[]): string {
  let s = ''
  const walk = (n: unknown) => {
    if (typeof n === 'string') { s += n; return }
    if (Array.isArray(n)) return n.forEach(walk)
    if (n && typeof n === 'object' && 'props' in (n as ReactElement)) {
      walk((n as ReactElement<{ children?: unknown }>).props?.children)
    }
  }
  nodes.forEach(walk)
  return s
}

test('renders the four WhatsApp markers', () => {
  assert.deepEqual(tags(renderWaText('*bold*')), ['strong'])
  assert.deepEqual(tags(renderWaText('_italic_')), ['em'])
  assert.deepEqual(tags(renderWaText('~struck~')), ['s'])
  assert.deepEqual(tags(renderWaText('`code`')), ['code'])
  assert.equal(text(renderWaText('*bold*')), 'bold', 'the asterisks are consumed')
  assert.equal(text(renderWaText('Hi *there* ok')), 'Hi there ok')
})

test('does NOT mangle arithmetic, identifiers or prices', () => {
  // The whole reason for the lookarounds.
  assert.deepEqual(tags(renderWaText('2*3*4')), [])
  assert.equal(text(renderWaText('2*3*4')), '2*3*4')
  assert.deepEqual(tags(renderWaText('snake_case_name')), [])
  assert.equal(text(renderWaText('snake_case_name')), 'snake_case_name')
  assert.deepEqual(tags(renderWaText('file_name_here.pdf')), [])
  assert.deepEqual(tags(renderWaText('R4500*')), [], 'a lone trailing marker is literal')
})

test('linkifies URLs but leaves the rest of the text alone', () => {
  const nodes = renderWaText('See https://cthalaal.co.za/exhibitor for details')
  assert.deepEqual(tags(nodes), ['a'])
  assert.equal(text(nodes), 'See https://cthalaal.co.za/exhibitor for details')
  // A bare domain is not a link — we only match http(s).
  assert.deepEqual(tags(renderWaText('cthalaal.co.za')), [])
})

test('fenced blocks are verbatim, so code keeps its asterisks', () => {
  const nodes = renderWaText('before ```a*b*c``` after')
  assert.ok(tags(nodes).includes('pre'))
  assert.ok(!tags(nodes).includes('strong'), 'markup inside a fence is not parsed')
  assert.match(text(nodes), /a\*b\*c/)
})

test('empty and plain input', () => {
  assert.deepEqual(renderWaText(''), [])
  assert.deepEqual(renderWaText(null), [])
  assert.deepEqual(tags(renderWaText('just a normal message')), [])
  assert.equal(text(renderWaText('just a normal message')), 'just a normal message')
})
