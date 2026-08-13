import { randomUUID } from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { and, eq } from "drizzle-orm"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/db"
import { drafts, learners, programWeeks, programs, sessions } from "@/db/schema"
import { __setCacheDirForTest, __setProviderForTest } from "@/lib/llm/adapter"
import { mockProvider } from "@/lib/llm/providers/mock"
import { pinMockProviderForTest } from "@/lib/llm/testSupport"
import type { Provider } from "@/lib/llm/providers/types"
import { loadCohortId } from "@/lib/placement"
import { POST } from "./route"

// Same isolation pattern as programs/generate/route.test.ts: a temp cache
// dir so this file's calls (mock provider, plus the deliberately-fake
// providers used below) never touch the committed .llm-cache/ corpus.
let cacheDir: string
let cohortId: string
let learnerIds: string[]
let restoreProviderEnv: () => void

async function makeProgram(overrides: { horizonWeeks: number; currentWeek: number }): Promise<string> {
  const id = randomUUID()
  await db.insert(programs).values({
    id,
    cohortId,
    brief: `advance-route-test-${id}`,
    horizonWeeks: overrides.horizonWeeks,
    currentWeek: overrides.currentWeek,
  })
  return id
}

function callAdvance(programId: string): Promise<Response> {
  const req = new Request(`http://x/api/programs/${programId}/advance`, { method: "POST" })
  return POST(req, { params: Promise.resolve({ id: programId }) })
}

/** A schema-valid WeeklyPassSchema payload grounded in real learner ids, with everything overridable. */
function validPayload(weekNumber: number, overrides: Record<string, unknown> = {}) {
  return {
    weekNumber,
    onTrack: [learnerIds[0]],
    slipped: [],
    atRisk: [learnerIds[0]],
    managerBrief: "The team is making steady progress on this week's practice scenarios.",
    curriculumAdjustments: [{
      weekN: weekNumber,
      change: "Add a short warm-up drill before the main scenario.",
      reason: "Grounded in this week's facts.",
    }],
    drafts: [{
      learnerId: learnerIds[0],
      channel: "email" as const,
      subject: "Quick check-in",
      body: "Hi — just checking in on this week's practice.",
      reason: "Test fixture draft.",
    }],
    ...overrides,
  }
}

function fakeProvider(name: string, respond: (weekNumber: number) => unknown): Provider {
  return {
    name,
    async call({ prompt }) {
      const weekNumber = Number(/WEEK NUMBER:\s*(\d+)/.exec(prompt)?.[1] ?? "1")
      return { raw: respond(weekNumber), cost: 0 }
    },
  }
}

describe("POST /api/programs/[id]/advance", () => {
  beforeAll(async () => {
    // Pins LLM_PROVIDER=mock / REPLAY=0 for real, independent of .env — see
    // testSupport.ts for why setting process.env.LLM_PROVIDER here would NOT
    // be enough on its own.
    restoreProviderEnv = pinMockProviderForTest()
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "advance-route-cache-"))
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
    restoreProviderEnv()
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  it("advancing one week persists a program_weeks row and increments currentWeek", async () => {
    const programId = await makeProgram({ horizonWeeks: 3, currentWeek: 0 })

    const res = await callAdvance(programId)
    expect(res.status).toBe(200)

    const [program] = await db.select().from(programs).where(eq(programs.id, programId))
    expect(program.currentWeek).toBe(1)

    const [weekRow] = await db
      .select()
      .from(programWeeks)
      .where(and(eq(programWeeks.programId, programId), eq(programWeeks.n, 1)))
    expect(weekRow).toBeTruthy()
    expect(weekRow.advancedAt).not.toBeNull()
  })

  it("every persisted draft has status draft", async () => {
    const programId = await makeProgram({ horizonWeeks: 3, currentWeek: 0 })
    const res = await callAdvance(programId)
    expect(res.status).toBe(200)

    const draftRows = await db.select().from(drafts).where(eq(drafts.programId, programId))
    expect(draftRows.length).toBeGreaterThan(0)
    for (const d of draftRows) expect(d.status).toBe("draft")
  })

  it("advancing at currentWeek === horizonWeeks returns 400 and does not increment", async () => {
    const programId = await makeProgram({ horizonWeeks: 1, currentWeek: 1 })

    const res = await callAdvance(programId)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/horizon|already at week/i)

    const [program] = await db.select().from(programs).where(eq(programs.id, programId))
    expect(program.currentWeek).toBe(1) // unchanged
  })

  // This is the regression guard on the task's load-bearing architectural
  // rule: the model must never be trusted to do the onTrack/slipped
  // arithmetic. A provider that answers with deliberately, obviously wrong
  // lists (values that don't even resemble real learner ids) must have zero
  // effect on what's persisted — the route always overrides onTrack/slipped
  // with computeWeeklyFacts's own computed completion facts.
  describe("architectural guard — onTrack/slipped are never trusted from the model", () => {
    it("persists computeWeeklyFacts's completion facts even when the provider returns deliberately wrong onTrack/slipped", async () => {
      const programId = await makeProgram({ horizonWeeks: 3, currentWeek: 0 })

      __setProviderForTest(fakeProvider("deliberately-wrong-lists", weekNumber => validPayload(weekNumber, {
        // Obviously wrong: neither of these strings is a real learner id, and
        // they don't even come close to the actual completed/missed split.
        onTrack: ["not-a-real-learner-id"],
        slipped: ["also-not-a-real-learner-id", "definitely-fake"],
      })))

      try {
        const res = await callAdvance(programId)
        expect(res.status).toBe(200)
      } finally {
        __setProviderForTest(mockProvider)
      }

      // Ground truth: query the raw sessions table directly (not the route's
      // response, not computeWeeklyFacts's in-memory result) for week 1 of
      // this cohort, independent of anything the fake provider said.
      const weekSessions = await db
        .select({ learnerId: sessions.learnerId, completed: sessions.completed })
        .from(sessions)
        .where(and(eq(sessions.weekN, 1)))
      const cohortWeekSessions = weekSessions.filter(s => learnerIds.includes(s.learnerId))
      const expectedOnTrack = new Set(cohortWeekSessions.filter(s => s.completed).map(s => s.learnerId))
      const expectedSlipped = new Set(cohortWeekSessions.filter(s => !s.completed).map(s => s.learnerId))

      const [weekRow] = await db
        .select()
        .from(programWeeks)
        .where(and(eq(programWeeks.programId, programId), eq(programWeeks.n, 1)))
      const persistedOnTrack = new Set(weekRow.onTrack as string[])
      const persistedSlipped = new Set(weekRow.slipped as string[])

      expect(persistedOnTrack).toEqual(expectedOnTrack)
      expect(persistedSlipped).toEqual(expectedSlipped)
      // And explicitly: none of the fake provider's fabricated ids leaked through.
      expect(persistedOnTrack.has("not-a-real-learner-id")).toBe(false)
      expect(persistedSlipped.has("also-not-a-real-learner-id")).toBe(false)
    })
  })

  it("a provider returning curriculumAdjustments[].weekN out of range is rejected and nothing is persisted", async () => {
    const programId = await makeProgram({ horizonWeeks: 3, currentWeek: 0 })

    __setProviderForTest(fakeProvider("out-of-range-week", weekNumber => validPayload(weekNumber, {
      curriculumAdjustments: [{
        weekN: 999,
        change: "This targets a week that doesn't exist.",
        reason: "Deliberately out of range for the test.",
      }],
    })))

    try {
      const res = await callAdvance(programId)
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body.error).toMatch(/weekN|horizon|999/i)
    } finally {
      __setProviderForTest(mockProvider)
    }

    const [program] = await db.select().from(programs).where(eq(programs.id, programId))
    expect(program.currentWeek).toBe(0) // unchanged — nothing persisted

    const weekRows = await db
      .select()
      .from(programWeeks)
      .where(and(eq(programWeeks.programId, programId), eq(programWeeks.n, 1)))
    expect(weekRows).toHaveLength(0)

    const draftRows = await db.select().from(drafts).where(eq(drafts.programId, programId))
    expect(draftRows).toHaveLength(0)
  })
})
