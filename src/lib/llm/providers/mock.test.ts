import { describe, it, expect } from "vitest"
import { z } from "zod"
import { Placement, ProgramSchema, WeeklyPassSchema, QbrSchema } from "@/lib/schemas"
import { toStrictJsonSchema } from "../adapter"
import { mockProvider } from "./mock"

// Build a prompt shaped like the eventual "LEARNERS AND EVIDENCE" block
// (build guide Appendix A user-prompt shape): one block per learner, each
// citing real 9-digit utterance ids, so the mock has something to ground on.
function learnersAndEvidencePrompt(n: number): string {
  const blocks = Array.from({ length: n }, (_, i) => {
    const speakerId = String(i + 1).padStart(4, "0")
    const learnerId = `learner-${speakerId}`
    const utt1 = String(i * 2 + 1).padStart(9, "0")
    const utt2 = String(i * 2 + 2).padStart(9, "0")
    return `${learnerId}: mean expert accuracy 7.4\n  utterance ${utt1}: "Can I help you with that?"\n  utterance ${utt2}: "I understand the delay is frustrating."`
  })
  return `BRIEF: 24 support staff need escalation call practice.\n\nLEARNERS AND EVIDENCE:\n${blocks.join("\n")}\n\nProduce a complete program.`
}

const SYSTEM = "You design corporate language training programs."

describe("mockProvider — determinism", () => {
  it("returns byte-identical output for identical input", async () => {
    const jsonSchema = toStrictJsonSchema(ProgramSchema)
    const prompt = learnersAndEvidencePrompt(3)
    const a = await mockProvider.call({ system: SYSTEM, prompt, toolName: "program", jsonSchema, model: "m" })
    const b = await mockProvider.call({ system: SYSTEM, prompt, toolName: "program", jsonSchema, model: "m" })
    expect(JSON.stringify(a.raw)).toBe(JSON.stringify(b.raw))
  })

  it("costs nothing", async () => {
    const jsonSchema = toStrictJsonSchema(QbrSchema)
    const out = await mockProvider.call({ system: SYSTEM, prompt: "p", toolName: "qbr", jsonSchema, model: "m" })
    expect(out.cost).toBe(0)
  })
})

describe("mockProvider — schema validity", () => {
  it("produces a schema-valid ProgramSchema object", async () => {
    const jsonSchema = toStrictJsonSchema(ProgramSchema)
    const prompt = learnersAndEvidencePrompt(5)
    const { raw } = await mockProvider.call({ system: SYSTEM, prompt, toolName: "program", jsonSchema, model: "m" })
    const result = ProgramSchema.safeParse(raw)
    expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(true)
  })

  it("produces a schema-valid WeeklyPassSchema object", async () => {
    const jsonSchema = toStrictJsonSchema(WeeklyPassSchema)
    // Weekly-pass grounding (like placements) requires at least one real
    // learner id in context — see "mockProvider — weekly pass" below for the
    // grounding-specific assertions.
    const prompt = "WEEK NUMBER: 2\n\nCOMPLETED THIS WEEK:\n  learner-0001: 1 session(s) completed"
    const { raw } = await mockProvider.call({ system: SYSTEM, prompt, toolName: "weeklyPass", jsonSchema, model: "m" })
    const result = WeeklyPassSchema.safeParse(raw)
    expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(true)
  })

  it("produces a schema-valid QbrSchema object", async () => {
    const jsonSchema = toStrictJsonSchema(QbrSchema)
    const { raw } = await mockProvider.call({ system: SYSTEM, prompt: "quarterly review", toolName: "qbr", jsonSchema, model: "m" })
    const result = QbrSchema.safeParse(raw)
    expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(true)
  })
})

describe("mockProvider — placements", () => {
  it("emits exactly one grounded placement per learner, for 24 learners", async () => {
    const jsonSchema = toStrictJsonSchema(ProgramSchema)
    const prompt = learnersAndEvidencePrompt(24)
    const { raw } = await mockProvider.call({ system: SYSTEM, prompt, toolName: "program", jsonSchema, model: "m" })
    const result = ProgramSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.placements).toHaveLength(24)

    const utteranceIdsInPrompt = new Set(prompt.match(/\b\d{9}\b/g))
    for (const placement of result.data.placements) {
      expect(placement.evidenceUtteranceIds.length).toBeGreaterThan(0)
      for (const id of placement.evidenceUtteranceIds) {
        expect(utteranceIdsInPrompt.has(id), `evidence id ${id} must have appeared in the prompt`).toBe(true)
      }
    }

    // Every learner id from the prompt is placed exactly once.
    const placedLearnerIds = result.data.placements.map(p => p.learnerId).sort()
    const expectedLearnerIds = Array.from({ length: 24 }, (_, i) => `learner-${String(i + 1).padStart(4, "0")}`).sort()
    expect(placedLearnerIds).toEqual(expectedLearnerIds)
  })

  it("never invents an evidence id that isn't in the prompt", async () => {
    const jsonSchema = toStrictJsonSchema(z.array(Placement))
    // Two learners share a pool of utterance ids scattered through the prompt.
    const prompt = "learner-0001 and learner-0002 were evaluated.\nutterance 000000001 000000002 000000003 recorded."
    const { raw } = await mockProvider.call({ system: SYSTEM, prompt, toolName: "placement", jsonSchema, model: "m" })
    const arr = raw as Array<{ evidenceUtteranceIds: string[] }>
    const promptIds = new Set(prompt.match(/\b\d{9}\b/g))
    for (const p of arr) {
      for (const id of p.evidenceUtteranceIds) expect(promptIds.has(id)).toBe(true)
    }
  })
})

describe("mockProvider — weekly pass", () => {
  function weeklyPrompt(learnerIds: string[]): string {
    const completed = learnerIds.map(id => `  ${id}: 1 session(s) completed`).join("\n")
    return `WEEK NUMBER: 3\n\nCOMPLETED THIS WEEK:\n${completed}`
  }

  it("grounds onTrack, slipped, atRisk, and drafts in real learner ids from the prompt", async () => {
    const jsonSchema = toStrictJsonSchema(WeeklyPassSchema)
    const learnerIds = ["learner-0001", "learner-0002", "learner-0003", "learner-0004"]
    const prompt = weeklyPrompt(learnerIds)
    const { raw } = await mockProvider.call({ system: SYSTEM, prompt, toolName: "weeklyPass", jsonSchema, model: "m" })
    const result = WeeklyPassSchema.safeParse(raw)
    expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(true)
    if (!result.success) return

    const allowed = new Set(learnerIds)
    for (const id of [...result.data.onTrack, ...result.data.slipped, ...result.data.atRisk]) {
      expect(allowed.has(id), `${id} must be a real learner id from the prompt`).toBe(true)
    }
    for (const d of result.data.drafts) {
      expect(allowed.has(d.learnerId), `draft learnerId ${d.learnerId} must be a real learner id from the prompt`).toBe(true)
    }
  })

  it("echoes the WEEK NUMBER line from the prompt", async () => {
    const jsonSchema = toStrictJsonSchema(WeeklyPassSchema)
    const { raw } = await mockProvider.call({
      system: SYSTEM, prompt: weeklyPrompt(["learner-0009"]), toolName: "weeklyPass", jsonSchema, model: "m",
    })
    const result = WeeklyPassSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.weekNumber).toBe(3)
  })

  it("refuses to invent a learner id when the prompt names none", async () => {
    const jsonSchema = toStrictJsonSchema(WeeklyPassSchema)
    await expect(
      mockProvider.call({ system: SYSTEM, prompt: "no learners named here", toolName: "weeklyPass", jsonSchema, model: "m" }),
    ).rejects.toThrow(/refusing to invent/)
  })
})

describe("mockProvider — CEFR guard", () => {
  it("never writes a bare CEFR-shaped token into plainLanguage", async () => {
    const jsonSchema = toStrictJsonSchema(ProgramSchema)
    const prompt = learnersAndEvidencePrompt(2)
    const { raw } = await mockProvider.call({ system: SYSTEM, prompt, toolName: "program", jsonSchema, model: "m" })
    const result = ProgramSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (!result.success) return
    for (const c of result.data.successCriteria) {
      expect(c.plainLanguage).not.toMatch(/\b(A1|A2|B1|B2|C1|C2|CEFR)\b/i)
    }
  })
})
