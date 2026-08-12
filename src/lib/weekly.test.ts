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
