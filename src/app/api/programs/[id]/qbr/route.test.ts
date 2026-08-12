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

function fakeProvider(name: string, respond: () => unknown): Provider {
  return {
    name,
    async call() {
      return { raw: respond(), cost: 0 }
    },
  }
}

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
})
