import { describe, it, expect } from "vitest"
import { Placement, ProgramSchema, WeeklyPassSchema, Scenario } from "./schemas"

const validPlacement = {
  learnerId: "l1", band: "B1", rationale: "Consistent vowel substitution under load.",
  evidenceUtteranceIds: ["000010011"],
}

describe("Placement", () => {
  it("accepts a grounded placement", () => {
    expect(Placement.safeParse(validPlacement).success).toBe(true)
  })

  it("REJECTS a placement citing no evidence — the point of the schema", () => {
    const r = Placement.safeParse({ ...validPlacement, evidenceUtteranceIds: [] })
    expect(r.success).toBe(false)
  })

  it("rejects an unknown band", () => {
    expect(Placement.safeParse({ ...validPlacement, band: "D9" }).success).toBe(false)
  })

  it("rejects a rationale over 280 chars", () => {
    expect(Placement.safeParse({ ...validPlacement, rationale: "x".repeat(281) }).success).toBe(false)
  })
})

describe("Scenario", () => {
  it("requires between 3 and 8 target phrases", () => {
    const base = { title: "t", situation: "s", successLooksLike: "ok" }
    expect(Scenario.safeParse({ ...base, targetPhrases: ["a", "b"] }).success).toBe(false)
    expect(Scenario.safeParse({ ...base, targetPhrases: ["a", "b", "c"] }).success).toBe(true)
    expect(Scenario.safeParse({ ...base, targetPhrases: Array(9).fill("a") }).success).toBe(false)
  })
})

describe("WeeklyPassSchema", () => {
  it("requires every draft to state its triggering fact", () => {
    const draft = { learnerId: "l1", channel: "email", subject: "s", body: "b" }
    const pass = {
      weekNumber: 1, onTrack: [], slipped: [], atRisk: [], managerBrief: "ok",
      curriculumAdjustments: [], drafts: [draft],
    }
    expect(WeeklyPassSchema.safeParse(pass).success).toBe(false)          // no reason
    pass.drafts = [{ ...draft, reason: "Missed both week-1 sessions." }] as any
    expect(WeeklyPassSchema.safeParse(pass).success).toBe(true)
  })

  it("rejects a channel other than email or slack", () => {
    const pass = {
      weekNumber: 1, onTrack: [], slipped: [], atRisk: [], managerBrief: "ok",
      curriculumAdjustments: [],
      drafts: [{ learnerId: "l1", channel: "sms", subject: "s", body: "b", reason: "r" }],
    }
    expect(WeeklyPassSchema.safeParse(pass).success).toBe(false)
  })
})

describe("ProgramSchema successCriteria", () => {
  it("rejects CEFR codes in plainLanguage — managers do not speak CEFR", () => {
    const crit = { plainLanguage: "Reach B2 on escalation calls", measurableProxy: "x" }
    const r = ProgramSchema.shape.successCriteria.safeParse([crit, crit])
    expect(r.success).toBe(false)
  })

  it("accepts plain-language criteria", () => {
    const crit = {
      plainLanguage: "Handles an angry caller without switching to Korean",
      measurableProxy: "Completes 3 escalation scenarios with accuracy at or above 7",
    }
    expect(ProgramSchema.shape.successCriteria.safeParse([crit, crit]).success).toBe(true)
  })
})
