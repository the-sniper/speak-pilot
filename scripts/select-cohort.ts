import { bandForAccuracy } from "../src/lib/bands"

export type Arc = "strong" | "modest" | "plateau" | "declining" | "stopped"
export type SpeakerStats = {
  speakerId: string
  meanAccuracy: number
  utteranceTotals: number[]
  utteranceIds: string[]
}
export type Selected = {
  speakerId: string; arc: Arc; meanAccuracy: number; utteranceIds: string[]
}

const ARC_MIX: [Arc, number][] = [
  ["strong", 4], ["modest", 12], ["plateau", 5], ["declining", 2], ["stopped", 1],
]

/** Deterministic PRNG so seeding is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const spread = (s: SpeakerStats) =>
  Math.max(...s.utteranceTotals) - Math.min(...s.utteranceTotals)

/**
 * Selects 24 speakers satisfying two constraints at once:
 *  - arc mix (build guide 1c), driven by each speaker's real score spread
 *  - band spread, so the cohort is not 24 identical B2 cards
 * The cohort is curated; the band function it is graded against is not.
 */
export function selectCohort(corpus: SpeakerStats[], seed: number): Selected[] {
  const rand = mulberry32(seed)
  const taken = new Set<string>()
  const out: Selected[] = []

  // Wide spread suits improvement/decline arcs; tight spread suits plateau.
  const byWidest = [...corpus].sort((a, b) => spread(b) - spread(a) || a.speakerId.localeCompare(b.speakerId))
  const byTightest = [...byWidest].reverse()

  const pick = (pool: SpeakerStats[], arc: Arc, wantBand?: string) => {
    for (const s of pool) {
      if (taken.has(s.speakerId)) continue
      if (wantBand && bandForAccuracy(s.meanAccuracy) !== wantBand) continue
      taken.add(s.speakerId)
      const ordered = orderUtterances(s, arc)
      out.push({ speakerId: s.speakerId, arc, meanAccuracy: s.meanAccuracy, utteranceIds: ordered })
      return true
    }
    return false
  }

  // Seed one learner per band first so all five bands are represented.
  const seededBands: string[] = []
  for (const band of ["A1", "A2", "B1", "B2", "C1"]) {
    if (pick(byWidest, "modest", band)) seededBands.push(band)
  }

  // Bug fix: the brief's `n - out.filter(...).length` recomputes the seeded
  // "modest" count from `out` itself on every map iteration, which happens to
  // work for "modest" but is fragile — and more importantly it doesn't cap at
  // zero. If the band-seeding pass ever seeds MORE than the arc's target count
  // (impossible today with 5 bands vs. 12 modest slots, but not guaranteed by
  // the types), `n - seeded` goes negative and the inner `for (let i = 0; i <
  // n; i++)` loop simply never runs (negative bound), silently under-filling
  // the cohort below 24 with no error. Clamp at 0 so that failure mode can't
  // happen, and compute the seeded count once instead of re-deriving it.
  const seededModest = seededBands.length
  const remaining: [Arc, number][] = ARC_MIX.map(([arc, n]) =>
    [arc, arc === "modest" ? Math.max(0, n - seededModest) : n])

  for (const [arc, n] of remaining) {
    const pool = arc === "plateau" ? byTightest : byWidest
    for (let i = 0; i < n; i++) {
      if (!pick(pool, arc)) pick(corpus.filter(c => !taken.has(c.speakerId)), arc)
    }
  }

  // Stable order, jittered by the seeded PRNG so it is not sorted-looking.
  return out.map(o => ({ o, k: rand() })).sort((a, b) => a.k - b.k).map(x => x.o)
}

/**
 * Orders a speaker's real utterances to express the arc.
 * NOTE: this constructs a trajectory. The corpus has no time dimension —
 * every utterance was recorded in one sitting, and speechocean762 has no
 * repeated sessions per speaker. Ordering utterances into an "arc" here is a
 * narrative device for the demo, not a measured trend. Disclosed in the
 * app's honesty banner.
 */
function orderUtterances(s: SpeakerStats, arc: Arc): string[] {
  const paired = s.utteranceIds.map((id, i) => ({ id, total: s.utteranceTotals[i] }))
  const asc = [...paired].sort((a, b) => a.total - b.total).map(p => p.id)
  switch (arc) {
    case "strong":
    case "modest":   return asc
    case "declining": return [...asc].reverse()
    case "plateau":  return paired.map(p => p.id)             // leave in corpus order
    case "stopped":  return asc.slice(0, Math.ceil(asc.length * 0.5))
  }
}

/** Distributes utterances across the horizon; base capped at 3, remainder spread. */
export function weekPlan(utteranceCount: number, horizonWeeks: number): number[] {
  const base = Math.min(Math.floor(utteranceCount / horizonWeeks), 3)
  const rem = base < 3 ? utteranceCount - base * horizonWeeks : 0
  return Array.from({ length: horizonWeeks }, (_, i) =>
    Math.max(1, base + (i < rem ? 1 : 0)))
}
