import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import { eq } from "drizzle-orm"
import { db } from "@/db"
import { placements, programs, programWeeks } from "@/db/schema"
import { __setCacheDirForTest, __setProviderForTest } from "@/lib/llm/adapter"
import { mockProvider } from "@/lib/llm/providers/mock"
import { pinMockProviderForTest } from "@/lib/llm/testSupport"
import { learnerEvidenceIds, loadLearnersWithScores } from "@/lib/placement"
import type { ProviderCall } from "@/lib/llm/providers/types"
import { POST } from "./route"

async function collect(res: Response) {
  const text = await res.text()
  return text.split("\n\n").filter(Boolean).map(frame => {
    const ev = /event: (\w+)/.exec(frame)?.[1]
    const data = /data: (.*)/s.exec(frame)?.[1]
    return { event: ev, data: data ? JSON.parse(data) : null }
  })
}

// Code review fix round 1, Finding 1e: isolate this file from the committed
// .llm-cache/ corpus with a temp directory, same pattern as
// adapter.test.ts's REPLAY-stale-cache regression test — done regardless of
// the mock-provider cache fix (1f) below, as defense in depth.
let cacheDir: string
let restoreProviderEnv: () => void

describe("POST /api/programs/generate", () => {
  beforeAll(() => {
    // Pins LLM_PROVIDER=mock / REPLAY=0 for real, independent of .env — see
    // testSupport.ts for why setting process.env.LLM_PROVIDER here would NOT
    // be enough on its own.
    restoreProviderEnv = pinMockProviderForTest()
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "programs-generate-cache-"))
    __setCacheDirForTest(cacheDir)
  })

  afterAll(() => {
    __setCacheDirForTest(null)
    restoreProviderEnv()
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  it("emits the six sections in order, then done", async () => {
    const req = new Request("http://x/api/programs/generate", {
      method: "POST",
      body: JSON.stringify({ brief: "18 people on our Seoul support team. 10 weeks." }),
    })
    const frames = await collect(await POST(req))
    expect(frames.filter(f => f.event === "section").map(f => f.data.key)).toEqual([
      "cohort", "placements", "weeks", "cadence", "successCriteria", "kickoff",
    ])
    expect(frames.at(-1)!.event).toBe("done")
    expect(frames.at(-1)!.data.programId).toBeTruthy()
  })

  it("sets the SSE content type", async () => {
    const req = new Request("http://x/api/programs/generate", {
      method: "POST", body: JSON.stringify({ brief: "x" }),
    })
    expect((await POST(req)).headers.get("content-type")).toContain("text/event-stream")
  })

  it("emits one placement per seeded learner, each citing evidence", async () => {
    const req = new Request("http://x/api/programs/generate", {
      method: "POST", body: JSON.stringify({ brief: "18 people, Seoul support, 10 weeks" }),
    })
    const frames = await collect(await POST(req))
    const placementsPayload = frames.find(f => f.data?.key === "placements")!.data.payload
    expect(placementsPayload.length).toBe(24)
    for (const p of placementsPayload) expect(p.evidenceUtteranceIds.length).toBeGreaterThan(0)
  })

  // Code review fix round 1, Finding 2 (Important): the project's headline
  // claim is "every placement is traceable to a real recording." Nothing
  // previously verified that server-side — a well-shaped Placement citing an
  // id that was never actually shown to that learner would pass Zod
  // (evidenceUtteranceIds only checks non-empty) and get persisted as if it
  // were grounded. This test is the guard on that claim: a fake provider
  // returns a schema-valid placement for a real seeded learner, but citing a
  // fabricated utterance id that learner's evidence block never contained.
  // The route must reject it — emit an error naming the learner and the bad
  // id, and never write a placements row for it — not silently drop the bad
  // id and keep the rest.
  describe("grounding integrity — the central honesty guard", () => {
    it("rejects and never persists a placement citing evidence never shown to that learner", async () => {
      const cohortLearners = await loadLearnersWithScores()
      const target = cohortLearners[0]
      const realIds = new Set(learnerEvidenceIds(target))
      const fabricatedId = "999999999"
      expect(realIds.has(fabricatedId)).toBe(false) // sanity: this id must not be real evidence

      __setProviderForTest({
        name: "hallucinating-fake",
        call: async ({ toolName }) => {
          if (toolName === "cohort") {
            return {
              raw: { size: 24, l1: "Korean", role: "Support", horizonWeeks: 10, understanding: "test cohort" },
              cost: 0,
            }
          }
          if (toolName === "placements") {
            return {
              raw: [{
                learnerId: target.id,
                band: "A1",
                rationale: "fabricated evidence for the grounding-integrity test",
                evidenceUtteranceIds: [fabricatedId],
              }],
              cost: 0,
            }
          }
          throw new Error(`grounding-integrity test: unexpected toolName "${toolName}" — step 2 must fail before step 3 runs`)
        },
      })

      const distinctiveBrief = `grounding-integrity-test-${Date.now()}`
      try {
        const req = new Request("http://x/api/programs/generate", {
          method: "POST", body: JSON.stringify({ brief: distinctiveBrief }),
        })
        const frames = await collect(await POST(req))

        const errorFrame = frames.find(f => f.event === "error")
        expect(errorFrame).toBeTruthy()
        expect(errorFrame!.data.message).toContain(target.id)
        expect(errorFrame!.data.message).toContain(fabricatedId)
        expect(frames.some(f => f.data?.key === "placements")).toBe(false)

        const [program] = await db.select().from(programs).where(eq(programs.brief, distinctiveBrief))
        expect(program).toBeTruthy() // step 1 (cohort) still persisted — only the bad step must be rejected
        const persisted = await db.select().from(placements).where(eq(placements.programId, program.id))
        expect(persisted.length).toBe(0) // rejected, not silently persisted with the bad id dropped
      } finally {
        __setProviderForTest(mockProvider)
      }
    })

    // Fix round 2 on Task 12, Finding 1. Fix round 1 renumbered persisted
    // week rows to be sequential (n = array index + 1), which closes
    // duplicates and non-sequential numbering, but did nothing to bound the
    // COUNT — a provider free to return more weeks than the program's
    // horizon would still get every one of them persisted, with n running
    // past horizonWeeks. This is the regression guard on the fix that
    // closes it: groundedCurriculumSchema (route.ts) now rejects
    // weeks.length > horizonWeeks as a schema.safeParse failure, the same
    // mechanism the advance route already uses to reject an out-of-range
    // curriculumAdjustments[].weekN.
    it("rejects and never persists any week when a provider returns more weeks than the horizon", async () => {
      const HORIZON = 2 // fixed and small so "more weeks than this" is trivial to construct
      const TOO_MANY = HORIZON + 18

      function validScenario(i: number) {
        return {
          title: `Scenario ${i}`,
          situation: `Situation ${i}`,
          targetPhrases: ["Can you confirm the order number?", "I understand the delay is frustrating.", "Let me check that for you."],
          successLooksLike: "The learner keeps the exchange on track without losing the thread.",
        }
      }

      __setProviderForTest({
        name: "too-many-weeks-fake",
        call: async (args: ProviderCall) => {
          if (args.toolName === "cohort") {
            return {
              raw: { size: 24, l1: "Korean", role: "Support", horizonWeeks: HORIZON, understanding: "test cohort" },
              cost: 0,
            }
          }
          if (args.toolName === "curriculum") {
            // Otherwise fully schema-valid — every week and every scenario
            // shaped correctly — so the ONLY reason this can fail validation
            // is the weeks.length > horizonWeeks guard under test.
            return {
              raw: {
                weeks: Array.from({ length: TOO_MANY }, (_, i) => ({
                  n: i + 1,
                  theme: `Week ${i + 1} theme`,
                  scenarios: [validScenario(1), validScenario(2)],
                })),
                cadence: { sessionsPerWeek: 2, minutesPerSession: 10 },
                successCriteria: [
                  { plainLanguage: "Team members can now handle calls confidently.", measurableProxy: "proxy one" },
                  { plainLanguage: "Team members can now handle calls confidently.", measurableProxy: "proxy two" },
                ],
                kickoffMessage: { en: "Welcome to the program.", ko: "환영합니다." },
              },
              cost: 0,
            }
          }
          // Delegate cohort/placements' sibling step (placements) to the real
          // mock provider — it derives a schema-valid, grounded placement per
          // seeded learner from the prompt text on its own, so there's no
          // need to hand-roll 24 of them just to get to the curriculum step.
          return mockProvider.call(args)
        },
      })

      const distinctiveBrief = `too-many-weeks-test-${Date.now()}`
      try {
        const req = new Request("http://x/api/programs/generate", {
          method: "POST", body: JSON.stringify({ brief: distinctiveBrief }),
        })
        const frames = await collect(await POST(req))

        const errorFrame = frames.find(f => f.event === "error")
        expect(errorFrame).toBeTruthy()
        expect(errorFrame!.data.message).toContain(String(TOO_MANY))
        expect(errorFrame!.data.message).toContain(String(HORIZON))
        expect(frames.some(f => f.data?.key === "weeks")).toBe(false)

        const [program] = await db.select().from(programs).where(eq(programs.brief, distinctiveBrief))
        expect(program).toBeTruthy() // step 1 (cohort) still persisted — only the bad step must be rejected
        expect(program.horizonWeeks).toBe(HORIZON)

        // The actual regression guard: not one row exists for this program —
        // not a truncated-to-horizon set, not the full over-long set. The
        // whole curriculum step is rejected atomically, so nothing with
        // n > horizonWeeks (or n <= horizonWeeks, for that matter) ever
        // reaches the table.
        const weekRows = await db.select().from(programWeeks).where(eq(programWeeks.programId, program.id))
        expect(weekRows).toHaveLength(0)
        expect(weekRows.every(w => w.n <= HORIZON)).toBe(true) // vacuously true above, stated for clarity
      } finally {
        __setProviderForTest(mockProvider)
      }
    })
  })
})
