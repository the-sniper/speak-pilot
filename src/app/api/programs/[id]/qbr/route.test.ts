import { randomUUID } from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { and, eq } from "drizzle-orm"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/db"
import { learners, programQbrs, programs, sessions } from "@/db/schema"
import { __setCacheDirForTest, __setProviderForTest } from "@/lib/llm/adapter"
import { mockProvider } from "@/lib/llm/providers/mock"
import type { Provider } from "@/lib/llm/providers/types"
import { loadCohortId } from "@/lib/placement"
import { POST as advancePOST } from "../advance/route"
import { POST } from "./route"

// Same isolation pattern as advance/route.test.ts: a temp cache dir so this
// file's calls never touch the committed .llm-cache/ corpus, and a real
// seeded cohort so computeQbrFacts has real session/score data to compute
// over.
let cacheDir: string
let cohortId: string
let learnerIds: string[]

async function makeProgram(overrides: { horizonWeeks: number; currentWeek: number }): Promise<string> {
  const id = randomUUID()
  await db.insert(programs).values({
    id,
    cohortId,
    brief: `qbr-route-test-${id}`,
    horizonWeeks: overrides.horizonWeeks,
    currentWeek: overrides.currentWeek,
  })
  return id
}

function callQbr(programId: string): Promise<Response> {
  const req = new Request(`http://x/api/programs/${programId}/qbr`, { method: "POST" })
  return POST(req, { params: Promise.resolve({ id: programId }) })
}

function callAdvance(programId: string): Promise<Response> {
  const req = new Request(`http://x/api/programs/${programId}/advance`, { method: "POST" })
  return advancePOST(req, { params: Promise.resolve({ id: programId }) })
}

/** A schema-valid QbrSchema payload, with everything overridable. */
function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    headline: "The cohort is making steady progress this quarter.",
    narrative: "Most learners advanced at least one band, with a handful needing continued support.",
    wins: ["Completion held at 100% across the window."],
    risks: ["One learner remains flagged at risk."],
    recommendation: "Keep the current cadence and revisit at the next advance.",
    ...overrides,
  }
}

function fakeProvider(name: string, respond: (prompt: string) => unknown): Provider {
  return {
    name,
    async call({ prompt }) {
      return { raw: respond(prompt), cost: 0 }
    },
  }
}

// Independent of route.ts's own NO_CEFR — a fresh regex here means this test
// isn't just re-checking the guard against itself, it's an outside
// assertion that the guard's own definition of "a CEFR-shaped token" is
// what actually got kept out of both the prompt and the completion.
const BARE_BAND_TOKEN = /\b(A1|A2|B1|B2|C1|C2|CEFR)\b/i

describe("POST /api/programs/[id]/qbr", () => {
  beforeAll(async () => {
    process.env.LLM_PROVIDER = "mock"
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-route-cache-"))
    __setCacheDirForTest(cacheDir)
    cohortId = await loadCohortId()
    const rows = await db.select({ id: learners.id }).from(learners).where(eq(learners.cohortId, cohortId))
    learnerIds = rows.map(r => r.id)
    if (learnerIds.length === 0) {
      throw new Error("No learners found — has `npm run seed` been run?")
    }
  })

  afterAll(() => {
    __setCacheDirForTest(null)
    __setProviderForTest(mockProvider)
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  // Ambiguity resolution (Task 14): a program with no weeks completed has no
  // quarter to narrate. This is the refusal path, not a 200 with empty facts.
  it("refuses with 400 when no weeks have been completed yet", async () => {
    const programId = await makeProgram({ horizonWeeks: 3, currentWeek: 0 })

    const res = await callQbr(programId)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/no weeks|not.*completed/i)

    const rows = await db.select().from(programQbrs).where(eq(programQbrs.programId, programId))
    expect(rows).toHaveLength(0)
  })

  it("generating for an advanced program persists exactly one program_qbrs row with the computed facts", async () => {
    const programId = await makeProgram({ horizonWeeks: 3, currentWeek: 0 })
    const advanceRes = await callAdvance(programId)
    expect(advanceRes.status).toBe(200)

    const res = await callQbr(programId)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.facts.weeksCompleted).toBe(1)
    expect(body.facts.cohortSize).toBe(learnerIds.length)

    const rows = await db.select().from(programQbrs).where(eq(programQbrs.programId, programId))
    expect(rows).toHaveLength(1)
    expect(rows[0].weeksCompleted).toBe(1)
    // facts persisted verbatim, matching what the response returned — a
    // reload must never need to recompute cohort arithmetic to render.
    expect(rows[0].facts).toEqual(body.facts)
  })

  it("regenerating upserts the existing row rather than accumulating a second one", async () => {
    const programId = await makeProgram({ horizonWeeks: 3, currentWeek: 0 })
    await callAdvance(programId)

    const first = await callQbr(programId)
    expect(first.status).toBe(200)
    const second = await callQbr(programId)
    expect(second.status).toBe(200)

    const rows = await db.select().from(programQbrs).where(eq(programQbrs.programId, programId))
    expect(rows).toHaveLength(1)
  })

  // computeQbrFacts is the only place cohort arithmetic happens — this pins
  // that completion, straight off the seeded sessions table, is what the
  // route actually persists, independent of whatever a provider might say.
  it("completion counts trace to the real sessions table, not the model", async () => {
    const programId = await makeProgram({ horizonWeeks: 3, currentWeek: 0 })
    await callAdvance(programId)

    const res = await callQbr(programId)
    const body = await res.json()

    const weekOneSessions = await db
      .select({ learnerId: sessions.learnerId, completed: sessions.completed })
      .from(sessions)
      .where(and(eq(sessions.weekN, 1)))
    const cohortWeekOne = weekOneSessions.filter(s => learnerIds.includes(s.learnerId))
    const expectedCompleted = cohortWeekOne.filter(s => s.completed).length

    expect(body.facts.completion.totalSessions).toBe(cohortWeekOne.length)
    expect(body.facts.completion.completedSessions).toBe(expectedCompleted)
  })

  // Same CEFR-guard pattern as the weekly pass route's managerBrief check —
  // a provider that leaks a bare CEFR-shaped token anywhere in the model's
  // prose must fail schema validation, not get persisted.
  it("rejects a provider response that leaks a CEFR code and persists nothing", async () => {
    const programId = await makeProgram({ horizonWeeks: 3, currentWeek: 0 })
    await callAdvance(programId)

    __setProviderForTest(fakeProvider("cefr-leak", () => validPayload({
      narrative: "The cohort moved from A2 to B1 this quarter.",
    })))

    try {
      const res = await callQbr(programId)
      expect(res.status).toBe(502)
    } finally {
      __setProviderForTest(mockProvider)
    }

    const rows = await db.select().from(programQbrs).where(eq(programQbrs.programId, programId))
    expect(rows).toHaveLength(0)
  })

  // Fix round 1, Finding 3: the review found a real contradiction — the
  // prompt used to hand the model literal band letters (via fmtBandMovement)
  // and its own trailing instruction told it to "cite a specific number or
  // named trend above," while groundedQbrSchema's CEFR guard rejects any
  // bare A1/A2/B1/B2/C1 token anywhere in the output. A plausible completion
  // that followed the "cite a trend" instruction using the exact band
  // vocabulary it was just shown ("moved from B1 to B2") would fail its own
  // grounding check. This had never been exercised: the mock provider has no
  // QBR-specific handling, so QbrSchema always fell through to generic
  // genString filler that passes the guard trivially without ever citing a
  // real fact — proving filler survives, not that a grounded completion does.
  //
  // This fixture provider is deliberately NOT hand-authored, fixed text: it
  // parses the actual "up N, down N, unchanged N" line out of the prompt it
  // receives and echoes that real number back into `wins`, in plain
  // "moved up a level" language with no letter code — the same move a real
  // model plausibly makes when told to describe band movement "the same way
  // you were given it." If the prompt still handed out letters, or the
  // instruction still invited citing them, this is exactly the completion
  // shape that would trip groundedQbrSchema and this test would fail with a
  // 502, not a bad assertion.
  it("a completion that describes band movement in plain language, grounded in the real up-count, passes the CEFR guard", async () => {
    const programId = await makeProgram({ horizonWeeks: 3, currentWeek: 0 })
    await callAdvance(programId)
    await callAdvance(programId) // week 2 — gives band movement something to describe

    let capturedPrompt = ""
    __setProviderForTest(fakeProvider("grounded-plain-language", prompt => {
      capturedPrompt = prompt
      const upMatch = /up (\d+), down (\d+), unchanged (\d+)/.exec(prompt)
      if (!upMatch) throw new Error("test fixture: BAND MOVEMENT up/down/unchanged line not found in prompt")
      const [, up, down, unchanged] = upMatch
      return validPayload({
        narrative:
          `${up} learners moved up a pronunciation level this quarter, ${down} moved down, and ` +
          `${unchanged} held steady — completion stayed strong across the window.`,
        wins: [`${up} of the cohort moved up a level in pronunciation accuracy this quarter.`],
        risks: [`${down} learner(s) moved down a level and may need targeted review.`],
      })
    }))

    try {
      const res = await callQbr(programId)
      expect(res.status).toBe(200)
      const body = await res.json()

      // Grounded in the real facts, not a coincidence: the number echoed
      // back in wins is exactly computeQbrFacts's own up-count for this run.
      expect(body.wins[0]).toContain(String(body.facts.bandMovement.up))

      // The prompt itself never handed the model a letter to echo —
      // fmtBandMovement now emits "level N", not a band letter.
      expect(capturedPrompt).not.toMatch(BARE_BAND_TOKEN)
      // ...and the surviving completion, grounded in that letter-free
      // prompt, is itself letter-free — the guard and the instruction agree.
      expect(body.narrative).not.toMatch(BARE_BAND_TOKEN)
      expect(body.wins.join(" ")).not.toMatch(BARE_BAND_TOKEN)
      expect(body.risks.join(" ")).not.toMatch(BARE_BAND_TOKEN)
    } finally {
      __setProviderForTest(mockProvider)
    }

    const rows = await db.select().from(programQbrs).where(eq(programQbrs.programId, programId))
    expect(rows).toHaveLength(1)
  })
})
