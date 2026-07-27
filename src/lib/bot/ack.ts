// "Does this even want a reply?"
//
// A vendor reacted ❤️ to her approval and typed "Yeaaahh". The bot answered
// "Haha, love the energy! 😄 What's got you excited, are we celebrating
// something specific...", turning the end of a conversation into a new one.
// Taona, 2026-07-27: "be careful to not respond to every message and when
// conversations end right."
//
// A prompt rule cannot be trusted with this: the same instruction was already in
// the system prompt and the model still answered, because answering is what it
// is for. So the decision is made HERE, deterministically, before the model is
// ever asked. Real people let a conversation end. The bot has to be allowed to
// as well.
//
// Deliberately narrow. It fires only on a short, question-free closer. Anything
// with a question mark, anything long, anything carrying a real word we do not
// recognise gets a reply exactly as before, because a missed reply to a vendor
// who wanted one is far worse than one unnecessary "you're welcome".

/** Closers. Elongation ("yeaaahh", "thankssss") is normalised before matching. */
const CLOSERS = new Set([
  'ok', 'okay', 'k', 'kk', 'oke', 'okey',
  'thanks', 'thank you', 'thankyou', 'thx', 'ty', 'tks', 'shukran', 'jazakallah', 'jzk',
  'yes', 'ye', 'yeah', 'yah', 'yep', 'yup', 'ya',
  'cool', 'nice', 'great', 'good', 'lekker', 'awesome', 'perfect', 'excellent', 'wonderful',
  'noted', 'sure', 'alright', 'right', 'fine', 'done', 'got it', 'gotit', 'understood',
  'amazing', 'lovely', 'brilliant', 'super', 'sweet', 'yay', 'woohoo', 'yeah man',
  'no problem', 'np', 'welcome', 'youre welcome', 'much appreciated', 'appreciated',
  'bye', 'goodbye', 'cheers', 'later', 'good night', 'goodnight', 'salaam', 'shot',
  'will do', 'willdo', 'okay thanks', 'ok thanks', 'thanks alot', 'thanks a lot',
  'thank you so much', 'thanks so much', 'many thanks', 'ok cool', 'cool thanks',
])

/**
 * Strip everything that carries no lexical meaning: emoji, punctuation, accents,
 * and runs of a repeated letter (so "yeaaahh" and "thankssss" reduce to their
 * dictionary forms rather than needing an entry each).
 */
function normalise(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}️‍]/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .toLowerCase()
    .replace(/(\p{L})\1{1,}/gu, '$1')       // yeaaahh -> yeah, thankssss -> thanks
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * True when the message is an acknowledgement that closes a conversation rather
 * than opening one: a reaction, an emoji, or a short thanks/ok with no question.
 */
export function isAcknowledgement(text: string | null | undefined): boolean {
  const raw = (text || '').trim()
  if (!raw) return false
  // A question is never a closer, however short. "ok?" wants an answer.
  if (/[?？]/.test(raw)) return false

  const n = normalise(raw)
  // Emoji-only or punctuation-only: nothing lexical survived.
  if (!n) return true
  // Guard the elongation collapse: "cool" -> "col", "yeah" stays "yeah". Match
  // both the collapsed form and the raw lowercase form so neither is missed.
  const plain = raw.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
  if (CLOSERS.has(n) || CLOSERS.has(plain)) return true
  // Collapse doubled letters in the dictionary too, so "cool" (-> "col") and
  // "thanks a lot" survive the same normalisation the input went through.
  for (const c of CLOSERS) if (normalise(c) === n) return true
  return false
}
