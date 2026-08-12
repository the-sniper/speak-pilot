// Pure arithmetic only. No model-adapter import in this file, ever — the
// weekly pass's load-bearing rule is that code computes what happened and
// the model only decides what to say about it. The advance route calls
// computeWeeklyFacts, then hands the result to the schema-constrained
// generation adapter as facts the model is instructed to treat as true,
// never to recompute. A grep for the adapter's entry point against this file
// must return nothing — that is the structural guarantee, not a style
// preference.

/** One seeded session, flattened with that week's mean utterance total. */
export type SessionRow = {
  learnerId: string
  weekN: number
  completed: boolean
  total: number // mean sentence `total` across that week's utterances
}

/**
 * One phoneme-miss occurrence for a given week — the caller (the advance
 * route) has already applied whatever "missed" threshold it uses (see
 * placement.ts's MISS_THRESHOLD) before building this list. weekly.ts stays
 * agnostic of scoring thresholds; it only counts what it's told already
 * counts as a miss, exactly like it only counts `completed` as given rather
 * than deriving completion from scores.
 */
export type MissedPhonemeRow = {
  weekN: number
  phone: string
}

export type WeeklyFacts = {
  weekNumber: number
  completed: { learnerId: string; sessions: number }[]
  missed: { learnerId: string; sessions: number }[]
  movement: { learnerId: string; deltaTotal: number; from: number; to: number }[]
  missedPhonemes: { phone: string; count: number }[]
}

// Cap the phoneme list the same way evidence.ts caps per-learner phoneme
// lines (MAX_PHONEMES_SHOWN) — a bounded, most-frequent-first list is what a
// prompt (and a manager) actually wants, not every phone that was ever wrong.
const MAX_MISSED_PHONEMES = 10

// Guards against float noise (e.g. 7.1 - 5.05) surfacing as a movement value
// with more precision than the underlying scores actually carry.
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function meanTotalByLearner(rows: SessionRow[]): Map<string, number> {
  const sums = new Map<string, { sum: number; n: number }>()
  for (const r of rows) {
    const cur = sums.get(r.learnerId) ?? { sum: 0, n: 0 }
    cur.sum += r.total
    cur.n += 1
    sums.set(r.learnerId, cur)
  }
  return new Map([...sums].map(([learnerId, { sum, n }]) => [learnerId, sum / n]))
}

/**
 * Computes the week's facts straight from seeded session/utterance data — who
 * completed, who missed, how each learner's mean sentence score moved versus
 * the previous week, and which phonemes came up most as misses this week.
 * Pure: same rows + weekNumber always produce the same facts, and nothing
 * here asks a model anything.
 *
 * `phonemeRows` is optional (defaults to none) so call sites that don't have
 * phoneme data handy — and every test in weekly.test.ts — can call this with
 * just (rows, weekNumber).
 */
export function computeWeeklyFacts(
  rows: SessionRow[],
  weekNumber: number,
  phonemeRows: MissedPhonemeRow[] = [],
): WeeklyFacts {
  const thisWeek = rows.filter(r => r.weekN === weekNumber)
  const prevWeek = rows.filter(r => r.weekN === weekNumber - 1)

  const byLearnerThisWeek = new Map<string, SessionRow[]>()
  for (const r of thisWeek) {
    const arr = byLearnerThisWeek.get(r.learnerId) ?? []
    arr.push(r)
    byLearnerThisWeek.set(r.learnerId, arr)
  }

  const completed: WeeklyFacts["completed"] = []
  const missed: WeeklyFacts["missed"] = []
  for (const [learnerId, learnerRows] of byLearnerThisWeek) {
    const completedCount = learnerRows.filter(r => r.completed).length
    const missedCount = learnerRows.filter(r => !r.completed).length
    if (completedCount > 0) completed.push({ learnerId, sessions: completedCount })
    if (missedCount > 0) missed.push({ learnerId, sessions: missedCount })
  }

  // Score movement: mean `total` this week minus mean `total` the previous
  // week, per learner. A learner with no prior-week row (week 1, or any week
  // where they simply have no earlier record) gets from === to, so
  // deltaTotal is 0 — "no movement" rather than a fabricated cliff.
  const thisWeekMeans = meanTotalByLearner(thisWeek)
  const prevWeekMeans = meanTotalByLearner(prevWeek)
  const movement: WeeklyFacts["movement"] = [...thisWeekMeans.entries()].map(([learnerId, to]) => {
    const from = prevWeekMeans.has(learnerId) ? prevWeekMeans.get(learnerId)! : to
    return { learnerId, deltaTotal: round2(to - from), from: round2(from), to: round2(to) }
  })

  const phoneCounts = new Map<string, number>()
  for (const p of phonemeRows) {
    if (p.weekN !== weekNumber) continue
    phoneCounts.set(p.phone, (phoneCounts.get(p.phone) ?? 0) + 1)
  }
  const missedPhonemes = [...phoneCounts.entries()]
    .map(([phone, count]) => ({ phone, count }))
    // count desc, then phone asc — deterministic regardless of input order,
    // which is what "pure — same input always yields the same facts" means
    // once ties are possible (Map iteration order alone isn't a promise
    // callers should have to rely on).
    .sort((a, b) => b.count - a.count || a.phone.localeCompare(b.phone))
    .slice(0, MAX_MISSED_PHONEMES)

  return { weekNumber, completed, missed, movement, missedPhonemes }
}
