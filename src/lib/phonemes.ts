export type PhoneToken = { phone: string; score: 0 | 1 | 2 | null; inserted: boolean }

const BRACKET_PAIRS: Record<string, string> = { "{": "}", "(": ")", "[": "]" }
const HAS_BRACKET = /[(){}[\]]/

/**
 * speechocean762 notates per-expert phone verdicts inline against the reference:
 *   bare  -> 2 (correct)     {X} -> 1 (accented)
 *   (X)   -> 0 (wrong/missed) [X] -> inserted phone, unscored
 *
 * A malformed token (mismatched bracket types, e.g. "(EH0]"; a stray bracket
 * character, e.g. "EH0)"; or nested/empty brackets, e.g. "{[X]}" / "()") throws
 * rather than being silently coerced into some score. Malformed markup means our
 * understanding of the data is wrong, and every downstream evidence claim would
 * inherit a mis-scored phone if we guessed instead of failing loudly.
 */
export function parsePhoneMarkup(expertPhones: string): PhoneToken[] {
  return expertPhones
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      const open = tok[0]
      if (open in BRACKET_PAIRS) {
        const close = tok[tok.length - 1]
        const phone = tok.slice(1, -1)
        if (BRACKET_PAIRS[open] !== close || phone.length === 0 || HAS_BRACKET.test(phone)) {
          throw new Error(`Malformed phone markup token "${tok}": mismatched or nested brackets`)
        }
        if (open === "{") return { phone, score: 1 as const, inserted: false }
        if (open === "(") return { phone, score: 0 as const, inserted: false }
        return { phone, score: null, inserted: true }
      }
      if (HAS_BRACKET.test(tok)) {
        throw new Error(`Malformed phone markup token "${tok}": unexpected bracket character`)
      }
      return { phone: tok, score: 2 as const, inserted: false }
    })
}

export type PhoneAgreement = {
  phone: string
  scores: (0 | 1 | 2)[]
  mean: number
  disagreement: number
  insertionsAfter: string[]
}

/**
 * Aligns every expert's markup to the reference phone sequence.
 * Insertions do not consume a reference position; they are attributed to the
 * preceding reference phone (index -1 means "before the first phone").
 */
export function phoneAgreement(refPhones: string, expertPhones: string[]): PhoneAgreement[] {
  const ref = refPhones.trim().split(/\s+/).filter(Boolean)
  const out: PhoneAgreement[] = ref.map((phone) => ({
    phone, scores: [], mean: 0, disagreement: 0, insertionsAfter: [],
  }))

  for (const markup of expertPhones) {
    let i = 0
    for (const tok of parsePhoneMarkup(markup)) {
      if (tok.inserted) {
        const at = Math.min(Math.max(i - 1, 0), out.length - 1)
        if (out[at]) out[at].insertionsAfter.push(tok.phone)
        continue
      }
      if (i < out.length && tok.score !== null) out[i].scores.push(tok.score)
      i++
    }
  }

  for (const p of out) {
    p.mean = p.scores.length ? p.scores.reduce((a: number, b) => a + b, 0) / p.scores.length : 0
    p.disagreement = p.scores.length ? Math.max(...p.scores) - Math.min(...p.scores) : 0
  }
  return out
}
