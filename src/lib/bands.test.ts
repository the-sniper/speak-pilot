import { describe, it, expect } from "vitest"
import { bandForAccuracy, bandDistance, BANDS } from "./bands"

describe("bandForAccuracy — cutoffs are fixed and must never be tuned to results", () => {
  it("maps the documented ranges", () => {
    expect(bandForAccuracy(3.93)).toBe("A1")   // corpus minimum
    expect(bandForAccuracy(5.49)).toBe("A1")
    expect(bandForAccuracy(5.5)).toBe("A2")
    expect(bandForAccuracy(6.9)).toBe("A2")
    expect(bandForAccuracy(7.0)).toBe("B1")
    expect(bandForAccuracy(7.99)).toBe("B1")
    expect(bandForAccuracy(8.0)).toBe("B2")
    expect(bandForAccuracy(8.6)).toBe("B2")
    expect(bandForAccuracy(8.61)).toBe("C1")
    expect(bandForAccuracy(9.31)).toBe("C1")   // corpus maximum
  })

  it("covers the full 0-10 range without gaps", () => {
    for (let x = 0; x <= 10; x += 0.05) {
      expect(BANDS).toContain(bandForAccuracy(x))
    }
  })
})

describe("bandDistance", () => {
  it("is zero for an exact match", () => {
    expect(bandDistance("B1", "B1")).toBe(0)
  })
  it("counts steps along the ladder, unsigned", () => {
    expect(bandDistance("A1", "A2")).toBe(1)
    expect(bandDistance("C1", "B2")).toBe(1)
    expect(bandDistance("A1", "C1")).toBe(4)
  })
})
