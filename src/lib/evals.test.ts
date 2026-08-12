import { describe, it, expect } from "vitest"
import { placementAccuracy, schemaConformance, latencyPercentiles, judgeAgreement } from "./evals"

describe("placementAccuracy — reports BOTH metrics, never just the flattering one", () => {
  it("computes exact and within-one separately", () => {
    const r = placementAccuracy([
      { predicted: "B1", truth: "B1" },   // exact
      { predicted: "B2", truth: "B1" },   // within one
      { predicted: "C1", truth: "A1" },   // neither
      { predicted: "A2", truth: "A2" },   // exact
    ])
    expect(r.n).toBe(4)
    expect(r.exact).toBeCloseTo(0.5)
    expect(r.withinOne).toBeCloseTo(0.75)
  })
  it("returns zeroes rather than NaN for an empty set", () => {
    expect(placementAccuracy([])).toEqual({ exact: 0, withinOne: 0, n: 0 })
  })
})

describe("schemaConformance", () => {
  it("separates first-try success from post-retry success", () => {
    const runs = [
      { ok: true,  attempt: 1 }, { ok: false, attempt: 1 }, { ok: true, attempt: 2 },
      { ok: false, attempt: 1 }, { ok: false, attempt: 2 },
    ] as any
    const c = schemaConformance(runs)
    expect(c.firstTry).toBeCloseTo(1 / 3)     // 1 of 3 logical calls valid first try
    expect(c.afterRetry).toBeCloseTo(2 / 3)   // 2 of 3 valid eventually
  })
})

describe("latencyPercentiles", () => {
  it("computes p50 and p95", () => {
    const runs = Array.from({ length: 100 }, (_, i) => ({ latencyMs: i + 1 })) as any
    const p = latencyPercentiles(runs)
    expect(p.p50).toBeGreaterThanOrEqual(50)
    expect(p.p95).toBeGreaterThanOrEqual(95)
  })
})

describe("judgeAgreement", () => {
  it("is 1 when the judge and the human agree exactly", () => {
    expect(judgeAgreement([3, 2, 1], [3, 2, 1])).toBe(1)
  })
  it("is 0 when they never agree", () => {
    expect(judgeAgreement([3, 3, 3], [0, 0, 0])).toBe(0)
  })
})
