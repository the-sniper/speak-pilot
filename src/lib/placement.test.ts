import { describe, it, expect } from "vitest"
import { buildLearnerBlock } from "./placement"

const learner = {
  id: "learner_07", name: "Jiwon Park",
  utterances: [
    { id: "u_1043", accuracy: 5, fluency: 4, prosodic: 5 },
    { id: "u_1051", accuracy: 6, fluency: 5, prosodic: 5 },
  ],
  missedPhonemes: [{ phone: "AE1", count: 7 }, { phone: "R", count: 5 }],
}

describe("buildLearnerBlock", () => {
  it("includes the learner id and session count", () => {
    const b = buildLearnerBlock(learner as any)
    expect(b).toContain("learner_07")
    expect(b).toContain("2 sessions")
  })

  it("includes every utterance id so placements can cite real evidence", () => {
    const b = buildLearnerBlock(learner as any)
    expect(b).toContain("u_1043")
    expect(b).toContain("u_1051")
  })

  it("lists most-missed phonemes with counts", () => {
    expect(buildLearnerBlock(learner as any)).toContain("AE1 (7x)")
  })

  it("does NOT leak the learner's name — placement must not infer from names", () => {
    expect(buildLearnerBlock(learner as any)).not.toContain("Jiwon")
  })

  it("stays compact — no raw JSON dumps", () => {
    const b = buildLearnerBlock(learner as any)
    expect(b).not.toContain("{")
    expect(b.length).toBeLessThan(600)
  })
})
