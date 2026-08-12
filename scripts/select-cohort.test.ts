import { describe, it, expect } from "vitest"
import { selectCohort, weekPlan } from "./select-cohort"
import { bandForAccuracy } from "../src/lib/bands"

const corpus = Array.from({ length: 250 }, (_, i) => ({
  speakerId: String(i).padStart(4, "0"),
  meanAccuracy: 3.9 + (i / 249) * 5.4,          // spans the real 3.93..9.31 range
  utteranceTotals: Array.from({ length: 20 }, (_, j) => 4 + ((i + j) % 7)),
  utteranceIds: Array.from({ length: 20 }, (_, j) => `u${i}_${j}`),
}))

describe("weekPlan — distributes 20 utterances without overflowing", () => {
  it("gives 2 per week across a 10-week horizon", () => {
    expect(weekPlan(20, 10)).toEqual(Array(10).fill(2))
  })
  it("never assigns more than 20 utterances in total", () => {
    for (const n of [4, 6, 8, 10, 12, 16]) {
      expect(weekPlan(20, n).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(20)
    }
  })
  it("caps at 3 sessions per week on a short horizon", () => {
    expect(Math.max(...weekPlan(20, 4))).toBeLessThanOrEqual(3)
  })
  it("gives every week at least one session on a long horizon", () => {
    expect(Math.min(...weekPlan(20, 16))).toBeGreaterThanOrEqual(1)
    expect(weekPlan(20, 16)).toHaveLength(16)
  })
})

describe("selectCohort", () => {
  it("selects exactly 24 learners", () => {
    expect(selectCohort(corpus, 42)).toHaveLength(24)
  })

  it("matches the required arc mix", () => {
    const counts = selectCohort(corpus, 42).reduce<Record<string, number>>((a, s) => {
      a[s.arc] = (a[s.arc] ?? 0) + 1
      return a
    }, {})
    expect(counts).toEqual({ strong: 4, modest: 12, plateau: 5, declining: 2, stopped: 1 })
  })

  it("is deterministic for a fixed seed", () => {
    expect(selectCohort(corpus, 42)).toEqual(selectCohort(corpus, 42))
  })

  it("never selects the same speaker twice", () => {
    const ids = selectCohort(corpus, 42).map(s => s.speakerId)
    expect(new Set(ids).size).toBe(24)
  })

  it("spans at least four bands so the demo is not one flat block", () => {
    const bands = new Set(selectCohort(corpus, 42).map(s => bandForAccuracy(s.meanAccuracy)))
    expect(bands.size).toBeGreaterThanOrEqual(4)
  })

  it("gives the stopped learner fewer utterances than the others", () => {
    const out = selectCohort(corpus, 42)
    const stopped = out.find(s => s.arc === "stopped")!
    const normal = out.find(s => s.arc === "modest")!
    expect(stopped.utteranceIds.length).toBeLessThan(normal.utteranceIds.length)
  })
})
