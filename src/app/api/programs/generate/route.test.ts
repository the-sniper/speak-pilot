import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import { eq } from "drizzle-orm"
import { db } from "@/db"
import { placements, programs } from "@/db/schema"
import { __setCacheDirForTest, __setProviderForTest } from "@/lib/llm/adapter"
import { mockProvider } from "@/lib/llm/providers/mock"
import { learnerEvidenceIds, loadLearnersWithScores } from "@/lib/placement"
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

describe("POST /api/programs/generate", () => {
  beforeAll(() => {
    process.env.LLM_PROVIDER = "mock"
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "programs-generate-cache-"))
    __setCacheDirForTest(cacheDir)
  })

  afterAll(() => {
    __setCacheDirForTest(null)
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
  })
})
