import { describe, it, expect } from "vitest"
import { parsePhoneMarkup, phoneAgreement } from "./phonemes"

describe("parsePhoneMarkup", () => {
  it("scores bare phones as 2", () => {
    expect(parsePhoneMarkup("W IY0")).toEqual([
      { phone: "W", score: 2, inserted: false },
      { phone: "IY0", score: 2, inserted: false },
    ])
  })

  it("scores {X} as 1 (accented)", () => {
    expect(parsePhoneMarkup("K {AO0} L")).toEqual([
      { phone: "K", score: 2, inserted: false },
      { phone: "AO0", score: 1, inserted: false },
      { phone: "L", score: 2, inserted: false },
    ])
  })

  it("scores (X) as 0 (wrong or missed), per the README's 'B (EH) R' example", () => {
    expect(parsePhoneMarkup("B (EH) R")).toEqual([
      { phone: "B", score: 2, inserted: false },
      { phone: "EH", score: 0, inserted: false },
      { phone: "R", score: 2, inserted: false },
    ])
  })

  it("marks [X] as an insertion with no score, per 'B EH [L] R'", () => {
    expect(parsePhoneMarkup("B EH [L] R")).toEqual([
      { phone: "B", score: 2, inserted: false },
      { phone: "EH", score: 2, inserted: false },
      { phone: "L", score: null, inserted: true },
      { phone: "R", score: 2, inserted: false },
    ])
  })

  it("handles multiple markups in one string", () => {
    expect(parsePhoneMarkup("B (EH0) (R)")).toEqual([
      { phone: "B", score: 2, inserted: false },
      { phone: "EH0", score: 0, inserted: false },
      { phone: "R", score: 0, inserted: false },
    ])
  })

  it("tolerates extra whitespace", () => {
    expect(parsePhoneMarkup("  B   EH0  ")).toHaveLength(2)
  })
})

describe("phoneAgreement", () => {
  // The real BEAR row from utterance 000010011 in scores-detail.json.
  const ref = "B EH0 R"
  const experts = ["B (EH0) (R)", "B {EH0} {R}", "B EH0 R", "B (EH0) (R)", "B EH0 [L] R"]

  it("returns one entry per reference phone, ignoring insertions", () => {
    const out = phoneAgreement(ref, experts)
    expect(out.map(p => p.phone)).toEqual(["B", "EH0", "R"])
  })

  it("collects every expert's score for a phone in order", () => {
    const out = phoneAgreement(ref, experts)
    expect(out[1].scores).toEqual([0, 1, 2, 0, 2])   // EH0
  })

  it("computes the mean across experts", () => {
    const out = phoneAgreement(ref, experts)
    expect(out[1].mean).toBeCloseTo(1.0, 5)          // (0+1+2+0+2)/5
  })

  it("reports disagreement as the score range", () => {
    const out = phoneAgreement(ref, experts)
    expect(out[1].disagreement).toBe(2)              // max 2, min 0
    expect(out[0].disagreement).toBe(0)              // B: everyone said 2
  })

  it("attributes an inserted phone to the position it follows", () => {
    const out = phoneAgreement(ref, experts)
    expect(out[1].insertionsAfter).toEqual(["L"])    // expert 5's intrusive L, after EH0
  })

  it("agrees with the aggregated means in scores.json for this row", () => {
    // scores.json phones-accuracy for BEAR is [2.0, 1.0, 1.0]; our EH0 mean is 1.0.
    const out = phoneAgreement(ref, experts)
    expect(out[0].mean).toBeCloseTo(2.0, 5)
    expect(out[1].mean).toBeCloseTo(1.0, 5)
  })
})
