import { describe, it, expect } from "vitest"
import { computeWeeklyFacts } from "./weekly"

const rows = [
  { learnerId: "a", weekN: 1, completed: true,  total: 5 },
  { learnerId: "a", weekN: 2, completed: true,  total: 7 },
  { learnerId: "b", weekN: 1, completed: true,  total: 6 },
  { learnerId: "b", weekN: 2, completed: false, total: 6 },
  { learnerId: "c", weekN: 1, completed: true,  total: 8 },
  { learnerId: "c", weekN: 2, completed: true,  total: 6 },
]

describe("computeWeeklyFacts", () => {
  it("counts completed sessions for the week", () => {
    const f = computeWeeklyFacts(rows, 2)
    expect(f.completed.map(c => c.learnerId).sort()).toEqual(["a", "c"])
  })

  it("counts missed sessions for the week", () => {
    expect(computeWeeklyFacts(rows, 2).missed.map(m => m.learnerId)).toEqual(["b"])
  })

  it("computes score movement against the previous week", () => {
    const f = computeWeeklyFacts(rows, 2)
    expect(f.movement.find(m => m.learnerId === "a")!.deltaTotal).toBe(2)    // 5 -> 7
    expect(f.movement.find(m => m.learnerId === "c")!.deltaTotal).toBe(-2)   // 8 -> 6
  })

  it("reports no movement for week 1, which has no prior week", () => {
    expect(computeWeeklyFacts(rows, 1).movement.every(m => m.deltaTotal === 0)).toBe(true)
  })

  it("is pure — the same input always yields the same facts", () => {
    expect(computeWeeklyFacts(rows, 2)).toEqual(computeWeeklyFacts(rows, 2))
  })
})

// Fix round 1, Finding 1: the advance route carries a learner's last KNOWN
// total forward across a missed week (or a run of them) instead of a
// fabricated 0, and stops carrying (passes `null`) once no known total
// exists at any distance back. computeWeeklyFacts doesn't do the carrying
// itself — that walk lives in the route, over data this pure function never
// sees — but it IS the layer that decides what a caller-supplied `null`
// means downstream: a learner is simply left out of `movement`, never given
// a fabricated numeric entry. These tests pin that contract directly against
// the pure function, independent of the route.
describe("computeWeeklyFacts — carry-forward and unknown totals", () => {
  it("one missed week: uses the carried-forward total, not a fabricated 0", () => {
    // Week 2 is missed, but the caller (route.ts) already carried the real
    // week-1 total (7) forward rather than passing 0.
    const oneGap = [
      { learnerId: "d", weekN: 1, completed: true, total: 7 },
      { learnerId: "d", weekN: 2, completed: false, total: 7 },
    ]
    const f = computeWeeklyFacts(oneGap, 2)
    const m = f.movement.find(x => x.learnerId === "d")
    expect(m).toEqual({ learnerId: "d", deltaTotal: 0, from: 7, to: 7 })
  })

  it("two consecutive missed weeks: still uses the multi-week carried-forward total, not 0", () => {
    // Learner's last REAL score was in some earlier week (not shown here —
    // computeWeeklyFacts only ever looks at weekNumber and weekNumber-1).
    // Both week 2 and week 3 were missed; the caller carried the real total
    // (9) across BOTH of them, simulating a gap wider than one week.
    const twoGap = [
      { learnerId: "d", weekN: 2, completed: false, total: 9 },
      { learnerId: "d", weekN: 3, completed: false, total: 9 },
    ]
    const f = computeWeeklyFacts(twoGap, 3)
    const m = f.movement.find(x => x.learnerId === "d")
    expect(m).toEqual({ learnerId: "d", deltaTotal: 0, from: 9, to: 9 })
    // The old bug would have surfaced here as {from: 0, to: 0} — assert
    // directly against that regression, not just the delta.
    expect(m!.from).not.toBe(0)
    expect(m!.to).not.toBe(0)
  })

  it("no prior data at all this week: the learner is omitted from movement, not reported as a fabricated 0", () => {
    const neverScored = [
      { learnerId: "e", weekN: 1, completed: false, total: null },
      { learnerId: "e", weekN: 2, completed: false, total: null },
    ]
    const f = computeWeeklyFacts(neverScored, 2)
    expect(f.movement.find(x => x.learnerId === "e")).toBeUndefined()
    // Still correctly reported as missed — the omission is specific to
    // movement, not a general disappearance from the week's facts.
    expect(f.missed.map(x => x.learnerId)).toContain("e")
  })

  it("first-ever known score, with no prior total to compare against: reports flat (from === to), not null-vs-number", () => {
    const firstScore = [
      { learnerId: "f", weekN: 1, completed: false, total: null },
      { learnerId: "f", weekN: 2, completed: true, total: 8 },
    ]
    const f = computeWeeklyFacts(firstScore, 2)
    const m = f.movement.find(x => x.learnerId === "f")
    expect(m).toEqual({ learnerId: "f", deltaTotal: 0, from: 8, to: 8 })
  })
})
