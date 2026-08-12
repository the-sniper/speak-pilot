import { describe, it, expect } from "vitest"
import { computeQbrFacts } from "./qbr"

const learners = [
  { id: "a", name: "Ana", role: "Support" },
  { id: "b", name: "Ben", role: "Support" },
  { id: "c", name: "Cy", role: "Support" },
]

// totalRows and accuracyRows share the same learnerId/weekN/completed shape
// as SessionRow — real call sites populate them from two different
// utterance columns (total vs accuracy), but for these fixtures a single
// set of numbers exercises the arithmetic identically.
const totalRows = [
  { learnerId: "a", weekN: 1, completed: true, total: 5 },
  { learnerId: "a", weekN: 2, completed: true, total: 7 },
  { learnerId: "b", weekN: 1, completed: true, total: 6 },
  { learnerId: "b", weekN: 2, completed: false, total: 6 },
  { learnerId: "c", weekN: 1, completed: true, total: 8 },
  { learnerId: "c", weekN: 2, completed: true, total: 6 },
]

describe("computeQbrFacts — completion", () => {
  it("counts completed vs total sessions across the window", () => {
    const f = computeQbrFacts({
      totalRows, accuracyRows: totalRows, learners, horizonWeeks: 2, weeksCompleted: 2, atRiskIds: [],
    })
    expect(f.completion.totalSessions).toBe(6)
    expect(f.completion.completedSessions).toBe(5) // everyone but b's week-2 row
    expect(f.completion.ratePct).toBeCloseTo((5 / 6) * 100, 1) // round2'd to 83.33
  })

  it("reports a 0% rate rather than dividing by zero when there are no sessions", () => {
    const f = computeQbrFacts({
      totalRows: [], accuracyRows: [], learners, horizonWeeks: 2, weeksCompleted: 0, atRiskIds: [],
    })
    expect(f.completion.ratePct).toBe(0)
  })
})

describe("computeQbrFacts — mostImproved", () => {
  it("lists only learners whose score rose, largest delta first", () => {
    const f = computeQbrFacts({
      totalRows, accuracyRows: totalRows, learners, horizonWeeks: 2, weeksCompleted: 2, atRiskIds: [],
    })
    // a: 5 -> 7 (+2), b: 6 -> 6 (0, excluded), c: 8 -> 6 (-2, excluded)
    expect(f.mostImproved).toEqual([{ learnerId: "a", name: "Ana", from: 5, to: 7, deltaTotal: 2 }])
  })

  it("is empty when nobody's score rose", () => {
    const flat = [
      { learnerId: "a", weekN: 1, completed: true, total: 5 },
      { learnerId: "a", weekN: 2, completed: true, total: 4 },
    ]
    const f = computeQbrFacts({
      totalRows: flat, accuracyRows: flat, learners, horizonWeeks: 2, weeksCompleted: 2, atRiskIds: [],
    })
    expect(f.mostImproved).toEqual([])
  })
})

describe("computeQbrFacts — bandMovement", () => {
  it("classifies each learner's first vs last known accuracy into a band direction", () => {
    // A1 < 5.5, A2 5.5-7.0, B1 7.0-8.0, B2 8.0-8.6, C1 > 8.6
    const accuracyRows = [
      { learnerId: "a", weekN: 1, completed: true, total: 4 },   // A1
      { learnerId: "a", weekN: 2, completed: true, total: 7.5 }, // B1 -> up
      { learnerId: "b", weekN: 1, completed: true, total: 8.2 }, // B2
      { learnerId: "b", weekN: 2, completed: true, total: 4 },   // A1 -> down
      { learnerId: "c", weekN: 1, completed: true, total: 6 },   // A2
      { learnerId: "c", weekN: 2, completed: true, total: 6.2 }, // A2 -> same
    ]
    const f = computeQbrFacts({
      totalRows, accuracyRows, learners, horizonWeeks: 2, weeksCompleted: 2, atRiskIds: [],
    })
    expect(f.bandMovement).toEqual({
      up: 1, down: 1, same: 1,
      perLearner: [
        { learnerId: "a", name: "Ana", startBand: "A1", endBand: "B1", direction: "up" },
        { learnerId: "b", name: "Ben", startBand: "B2", endBand: "A1", direction: "down" },
        { learnerId: "c", name: "Cy", startBand: "A2", endBand: "A2", direction: "same" },
      ],
    })
  })

  it("uses accuracyRows, not totalRows, for band classification — feeding totalRows would mislabel bands", () => {
    // A learner whose `total` composite looks unchanged but whose accuracy
    // alone crossed a band boundary must still show movement — proves the
    // two inputs are genuinely independent, not silently aliased.
    const rows = [{ learnerId: "a", weekN: 1, completed: true, total: 5 }]
    const accuracyRows = [
      { learnerId: "a", weekN: 1, completed: true, total: 3 }, // A1
      { learnerId: "a", weekN: 2, completed: true, total: 9 }, // C1
    ]
    const f = computeQbrFacts({
      totalRows: rows, accuracyRows, learners, horizonWeeks: 2, weeksCompleted: 2, atRiskIds: [],
    })
    expect(f.bandMovement.perLearner.find(p => p.learnerId === "a")).toEqual({
      learnerId: "a", name: "Ana", startBand: "A1", endBand: "C1", direction: "up",
    })
  })
})

describe("computeQbrFacts — atRisk", () => {
  it("resolves names for the given ids and falls back to the raw id when unresolved", () => {
    const f = computeQbrFacts({
      totalRows, accuracyRows: totalRows, learners, horizonWeeks: 2, weeksCompleted: 2,
      atRiskIds: ["b", "ghost"],
    })
    expect(f.atRisk).toEqual([
      { learnerId: "b", name: "Ben" },
      { learnerId: "ghost", name: "ghost" },
    ])
  })
})

describe("computeQbrFacts — purity", () => {
  it("is pure — the same input always yields the same facts", () => {
    const args = {
      totalRows, accuracyRows: totalRows, learners, horizonWeeks: 2, weeksCompleted: 2, atRiskIds: ["a"],
    }
    expect(computeQbrFacts(args)).toEqual(computeQbrFacts(args))
  })
})
