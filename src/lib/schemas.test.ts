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

  // Fix round 2: reverted round 1's context-aware containsCefrJargon() back to the
  // simple bare-token check. Round 1 made the guard precise but that precision
  // leaked genuine CEFR jargon through any phrasing outside its closed verb/keyword
  // list ("everyone should be B1", "aim for B1 by week 6", "target: C1", ...). The
  // bare-token check deliberately over-rejects instead — see the rationale comment
  // on SuccessCriterion.plainLanguage in schemas.ts for why that trade-off was made.
  const criterionWith = (plainLanguage: string) => ({
    plainLanguage,
    measurableProxy: "Completes 3 escalation scenarios with accuracy at or above 7",
  })

  it("still rejects genuine CEFR usage", () => {
    const rejected = [
      "Reach B2 on escalation calls",
      "Get everyone to CEFR level B1",
      "Move the team from A2 to B1",
      // Round-2 leak list: phrasings the round-1 context-aware check let through
      // because they used no verb from its closed list and no "level"/"proficiency"
      // keyword. The bare-token check catches all of these by design.
      "B2 by December",
      "everyone should be B1",
      "target: C1",
      "we expect B2 fluency",
      "aim for B1 by week 6",
      "bring the cohort up to B2",
      "everyone needs to be at B1",
      "learners will be B2 speakers",
      "B2 speaking ability",
      "staff should test at B2",
    ]
    for (const plainLanguage of rejected) {
      const crit = criterionWith(plainLanguage)
      expect(
        ProgramSchema.shape.successCriteria.safeParse([crit, crit]).success,
        `expected "${plainLanguage}" to be rejected`,
      ).toBe(false)
    }
  })

  it("over-rejects incidental band-shaped tokens, by design", () => {
    // See the rationale comment on SuccessCriterion.plainLanguage in schemas.ts:
    // this is a deliberate trade-off, not an oversight. A band-shaped token in
    // manager-facing prose about a language-training program is judged far more
    // likely to be CEFR jargon than a room number or pay grade, so both of these
    // are rejected even though neither actually references CEFR.
    const rejected = [
      "Meet in Room B2 at noon to practice",
      "Employee grade A1 evaluation covers call handling",
    ]
    for (const plainLanguage of rejected) {
      const crit = criterionWith(plainLanguage)
      expect(
        ProgramSchema.shape.successCriteria.safeParse([crit, crit]).success,
        `expected "${plainLanguage}" to be rejected (accepted false positive by design)`,
      ).toBe(false)
    }

    // Sanity check: prose with no band-shaped token at all must still be accepted.
    const crit = criterionWith("Handles an angry caller without switching to Korean")
    expect(ProgramSchema.shape.successCriteria.safeParse([crit, crit]).success).toBe(true)
  })
})
