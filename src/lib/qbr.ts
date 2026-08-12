// Pure arithmetic only, same rule as weekly.ts: no model-adapter import in
// this file, ever. The QBR route calls computeQbrFacts, then hands the
// result to callWithSchema as facts the model is instructed to treat as
// true, never to recompute — identical division of labour to the weekly
// pass, just rolled up over the whole quarter-to-date instead of one week.
//
// Every number this file produces is built from the same "one real session
// per speaker, sorted into weeks" construction the rest of the app already
// discloses (see SimulatedTag / HonestyBanner). Nothing here is a new kind
// of fabrication — it is a wider window over facts that are already
// constructed, computed the same carry-forward way weekly.ts computes them.

import { BANDS, bandForAccuracy, type Band } from "./bands"
import type { SessionRow } from "./weekly"

export type LearnerRef = { id: string; name: string; role: string }

export type BandMovementEntry = {
  learnerId: string
  name: string
  startBand: Band
  endBand: Band
  direction: "up" | "down" | "same"
}

export type MostImprovedEntry = {
  learnerId: string
  name: string
  from: number
  to: number
  deltaTotal: number
}

export type AtRiskEntry = { learnerId: string; name: string }

export type QbrFacts = {
  weeksCompleted: number
  horizonWeeks: number
  cohortSize: number
  completion: { completedSessions: number; totalSessions: number; ratePct: number }
  bandMovement: { up: number; down: number; same: number; perLearner: BandMovementEntry[] }
  mostImproved: MostImprovedEntry[]
  atRisk: AtRiskEntry[]
}

// Caps the headline "most improved" list the same way weekly.ts caps its
// phoneme list — a short, most-significant-first list is what a manager
// actually wants on a QBR, not a full cohort dump duplicating bandMovement.
const MAX_MOST_IMPROVED = 3

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * For each learner, the first and last known score across the rows given —
 * "known" meaning `total !== null`, ordered by weekN. A learner who never
 * had a scored session across the window is simply absent from the
 * returned map, same "omitted, not fabricated" convention weekly.ts uses
 * for its movement list.
 */
function firstAndLastKnown(rows: SessionRow[]): Map<string, { first: number; last: number }> {
  const byLearner = new Map<string, SessionRow[]>()
  for (const r of rows) {
    if (r.total === null) continue
    const arr = byLearner.get(r.learnerId) ?? []
    arr.push(r)
    byLearner.set(r.learnerId, arr)
  }
  const out = new Map<string, { first: number; last: number }>()
  for (const [learnerId, learnerRows] of byLearner) {
    const sorted = [...learnerRows].sort((a, b) => a.weekN - b.weekN)
    out.set(learnerId, { first: sorted[0].total!, last: sorted[sorted.length - 1].total! })
  }
  return out
}

/**
 * Computes cohort-level QBR facts straight from seeded session data. Pure:
 * same inputs always yield the same facts, and nothing here asks a model
 * anything.
 *
 * `totalRows` and `accuracyRows` are the SAME session shape (learnerId,
 * weekN, completed), carried forward across missed weeks the same way
 * weekly.ts's caller does — they differ ONLY in which utterance column was
 * averaged into `total`. Two separate arrays rather than one, because they
 * feed two dimensionally different facts:
 *   - `totalRows` (mean sentence `total`, the same figure the program
 *     overview's trajectory chart and the weekly pass's movement fact both
 *     already use) drives completion counts and mostImproved, for
 *     consistency with those existing screens.
 *   - `accuracyRows` (mean sentence `accuracy` specifically) drives
 *     bandMovement, because bandForAccuracy's cutoffs (src/lib/bands.ts)
 *     were derived from five-expert mean ACCURACY, not the four-metric
 *     composite `total`. Feeding `total` into a function calibrated on
 *     `accuracy` would silently mislabel bands with numbers on the wrong
 *     scale — a correctness bug, not just an honesty caveat.
 */
export function computeQbrFacts(args: {
  totalRows: SessionRow[]
  accuracyRows: SessionRow[]
  learners: LearnerRef[]
  horizonWeeks: number
  weeksCompleted: number
  atRiskIds: string[]
}): QbrFacts {
  const { totalRows, accuracyRows, learners, horizonWeeks, weeksCompleted, atRiskIds } = args
  const nameById = new Map(learners.map(l => [l.id, l.name]))

  const completedSessions = totalRows.filter(r => r.completed).length
  const totalSessions = totalRows.length
  const ratePct = totalSessions > 0 ? round2((completedSessions / totalSessions) * 100) : 0

  const totalFL = firstAndLastKnown(totalRows)
  const mostImproved: MostImprovedEntry[] = [...totalFL.entries()]
    .map(([learnerId, { first, last }]) => ({
      learnerId,
      name: nameById.get(learnerId) ?? learnerId,
      from: round2(first),
      to: round2(last),
      deltaTotal: round2(last - first),
    }))
    .filter(e => e.deltaTotal > 0)
    // Largest improvement first; ties break on learnerId so the list is
    // deterministic regardless of Map iteration order.
    .sort((a, b) => b.deltaTotal - a.deltaTotal || a.learnerId.localeCompare(b.learnerId))
    .slice(0, MAX_MOST_IMPROVED)

  const accFL = firstAndLastKnown(accuracyRows)
  let up = 0
  let down = 0
  let same = 0
  const perLearner: BandMovementEntry[] = []
  for (const [learnerId, { first, last }] of accFL) {
    const startBand = bandForAccuracy(first)
    const endBand = bandForAccuracy(last)
    const si = BANDS.indexOf(startBand)
    const ei = BANDS.indexOf(endBand)
    const direction: BandMovementEntry["direction"] = ei > si ? "up" : ei < si ? "down" : "same"
    if (direction === "up") up++
    else if (direction === "down") down++
    else same++
    perLearner.push({ learnerId, name: nameById.get(learnerId) ?? learnerId, startBand, endBand, direction })
  }
  perLearner.sort((a, b) => a.learnerId.localeCompare(b.learnerId))

  // atRiskIds is copied straight from the most recently advanced week's
  // persisted programWeeks row — already a computed fact from a prior
  // weekly pass, never re-derived here. A stray id with no matching learner
  // (unreachable today given NOT NULL FKs) falls back to the raw id rather
  // than a fabricated name, same convention as program-view.ts.
  const atRisk: AtRiskEntry[] = atRiskIds.map(id => ({ learnerId: id, name: nameById.get(id) ?? id }))

  return {
    weeksCompleted,
    horizonWeeks,
    cohortSize: learners.length,
    completion: { completedSessions, totalSessions, ratePct },
    bandMovement: { up, down, same, perLearner },
    mostImproved,
    atRisk,
  }
}
