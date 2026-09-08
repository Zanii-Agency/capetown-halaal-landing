import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAutoReply, countsAsWaitingInbound } from '@/lib/inbox/waiting-signals'

// Real WhatsApp Business greeting auto-replies pulled from wa_messages. The tail
// varies endlessly; the opener "thank you for contacting <business>" is the tell.
// Every one of these must be treated as a machine (they pinned as "waiting on a
// person" before the opener fix).
test('shop greeting auto-replies are machines, whatever the tail', () => {
  for (const b of [
    'Thank you for contacting Frullato! Please let us know how we can be of assistance to you',
    'Thank you for contacting MIZ🌸DAYZEE Please let us know how we can assist you.🌸😊',
    'Thank you for contacting Omega Pride Group! Whether you looking for our colouring books, leave a message',
    'Thank you for contacting Two Scoops Of Happiness! Please note we do not accept online orders',
    'Thank you for contacting Mr Clearance lansdowne!Our walk in store is closed .We do however have a online store',
    'Shukran/Thank you for contacting Call a Braai! Please let us know how we can help you?',
    'Asalaamu Alaikum/Good day. Shukran / Thank You for contacting Travel Essence! Please let us know how we can help you',
    'Hi/Aslm Thank you for contacting Manu’z Boutique! We unavailable right now but will get back to you',
    'Salaam/Hi Foodies thank you for contacting foodhangovercpt . Pre order via WhatsApp',
    'Wslm. Thank you for contacting us. We appreciate your message and will get back to you as soon as possible.',
    'Thank you for contacting House of Halwa. Please let us know how we can assist 💛',
  ]) {
    assert.equal(isAutoReply(b), true, `expected auto-reply: ${b.slice(0, 40)}`)
    assert.equal(countsAsWaitingInbound(b), false, `must not pin: ${b.slice(0, 40)}`)
  }
})

// The whole risk of the opener match is silencing a genuine person who happens to
// open with a thank-you. A human thanks US for contacting THEM ("me"/"my"), and a
// real question is never suppressed.
test('a real vendor asking for help still waits', () => {
  for (const b of [
    'Thank you for contacting me about my stall, here is my proof of payment',
    'Thank you for contacting my business earlier, when is the deadline?',
    'Hi, thanks for reaching out. Can I still change my stall size?',
    'Thank you so much! Quick question, is power included in the fee?',
    'When must I pay by? I have not received an invoice',
  ]) {
    assert.equal(countsAsWaitingInbound(b), true, `must still pin: ${b.slice(0, 40)}`)
  }
})
