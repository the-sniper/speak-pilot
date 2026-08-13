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
import { pinMockProviderForTest } from "@/lib/llm/testSupport"
import type { Provider } from "@/lib/llm/providers/types"
import { loadCohortId } from "@/lib/placement"
import { POST as advancePOST } from "../advance/route"
import { POST } from "./route"

// Same isolation pattern as advance/route.test.ts: a temp cache dir so this
// file's calls never touch the committed .llm-cache/ corpus, and a real
// seeded cohort so computeQbrFacts has real session/score data to compute
// over.
let cacheDir: string
let restoreProviderEnv: () => void
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

// Fix round 2, Finding B: `respond` now also receives `system` — the round-1
// version of this helper destructured only `{ prompt }`, so no test here
// ever actually looked at what QBR_SYSTEM_PROMPT contains. `provider.call`
// receives system and prompt as two separate fields; a claim that "the
// prompt is letter-free" is silently narrower than "what the model receives
// is letter-free" unless both are checked.
function fakeProvider(name: string, respond: (prompt: string, system: string) => unknown): Provider {
  return {
    name,
    async call({ prompt, system }) {
      return { raw: respond(prompt, system), cost: 0 }
    },
  }
}

// Independent of route.ts's own NO_CEFR — a fresh regex here means this test
// isn't just re-checking the guard against itself, it's an outside
// assertion that the guard's own definition of "a CEFR-shaped token" is
// what actually got kept out of the model's completion. Matches NO_CEFR
// exactly (route.ts) — this is what headline/narrative/wins/risks/
// recommendation are checked against, because groundedQbrSchema rejects the
// bare word CEFR from the model's OUTPUT too, not just a letter-digit code
// (see schemas.ts's SuccessCriterion.plainLanguage for the established
// precedent: never let the word "CEFR" reach a manager who was promised
// plain language).
const BARE_BAND_TOKEN = /\b(A1|A2|B1|B2|C1|C2|CEFR)\b/i

// Fix round 2, Finding B: a narrower check for what `prompt` and `system`
// (what the provider actually receives) must avoid — the letter-immediately-
// followed-by-digit SHORTHAND specifically (A1/A2/B1/B2/C1/C2), not the bare
// word "CEFR". Deliberately NOT the same regex as BARE_BAND_TOKEN above: the
// word "CEFR" legitimately appears in QBR_SYSTEM_PROMPT as a named concept
// ("these are not CEFR proficiency assessments"), in fixed, reviewed
// instructional text explaining to the model what to avoid and why — the
// same way WEEKLY_PASS_SYSTEM_PROMPT already says "no CEFR codes" in its own
// rule text, unchallenged. That is a different thing from a letter-digit
// code appearing as if it were a fact to cite (the round-1 bug: literal
// "B1"/"B2" values interpolated as ground truth), which is the specific
// shape this regex catches everywhere it could still hide.
const BAND_LETTER_CODE = /\b(A1|A2|B1|B2|C1|C2)\b/i

describe("POST /api/programs/[id]/qbr", () => {
  beforeAll(async () => {
    // Pins LLM_PROVIDER=mock / REPLAY=0 for real, independent of .env — see
    // testSupport.ts for why setting process.env.LLM_PROVIDER here would NOT
    // be enough on its own.
    restoreProviderEnv = pinMockProviderForTest()
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
    restoreProviderEnv()
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
  // Fix round 2, Finding A: a bare "level 1-5" has no semantic anchor — a
  // real completion could write "3 learners moved up a level" with nothing
  // tying that to pronunciation at all. Round 1's fixture hand-authored the
  // "pronunciation level" qualifier in its OWN return value, which proved
  // nothing about whether the model is actually told to include it — the
  // test would have passed identically if the prompt never mentioned
  // pronunciation. This version instead asserts the anchoring guidance is
  // present in what the model receives (prompt AND system), independent of
  // what the fixture chooses to write back.
  //
  // Fix round 2, Finding B: the fixture now also captures `system` —
  // `provider.call({ system, prompt })` sends two separate fields, and round
  // 1's fixture destructured only `prompt`, so QBR_SYSTEM_PROMPT (which
  // still carried literal band letters as a "never write this" example) was
  // never actually checked. Round 2 rewrote that example to describe the
  // forbidden SHAPE ("one capital letter directly followed by one digit")
  // instead of listing instances, so `system` is asserted letter-free here
  // exactly like `prompt` is — no caveat, no narrower claim.
  //
  // The fixture provider itself is deliberately NOT hand-authored, fixed
  // text: it parses the actual "up N, down N, unchanged N" line out of the
  // prompt it receives and echoes that real number back into `wins`, in
  // plain "moved up a level in pronunciation accuracy" language with no
  // letter code — the same move a real model plausibly makes when told to
  // describe band movement "the same way you were given it." If the prompt
  // still handed out letters, or the instruction still invited citing them,
  // this is exactly the completion shape that would trip groundedQbrSchema
  // and this test would fail with a 502, not a bad assertion.
  it("prompt+system instruct pronunciation-anchored, letter-free band movement, and a grounded completion passes the CEFR guard", async () => {
    const programId = await makeProgram({ horizonWeeks: 3, currentWeek: 0 })
    await callAdvance(programId)
    await callAdvance(programId) // week 2 — gives band movement something to describe

    let capturedPrompt = ""
    let capturedSystem = ""
    __setProviderForTest(fakeProvider("grounded-plain-language", (prompt, system) => {
      capturedPrompt = prompt
      capturedSystem = system
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

      // Finding A: the model is actually INSTRUCTED to anchor "level" to
      // pronunciation — checked against the raw prompt/system text, not
      // against what the fixture chose to write back.
      expect(capturedPrompt).toMatch(/pronunciation-accuracy\s+scores/i)
      expect(capturedSystem).toMatch(/pronunciation accuracy/i)
      expect(capturedSystem).toMatch(/name pronunciation explicitly/i)

      // Finding B: BOTH fields the provider actually receives are free of
      // the letter-digit shorthand (A1/A2/B1/B2/C1/C2), not just `prompt` —
      // `system` still teaches the forbidden shape, now without spelling
      // out a literal instance of it. `system` legitimately still names
      // "CEFR" itself as a concept (see BAND_LETTER_CODE's comment above for
      // why that's a deliberately narrower, more accurate claim than "every
      // forbidden token never appears").
      expect(capturedPrompt).not.toMatch(BAND_LETTER_CODE)
      expect(capturedSystem).not.toMatch(BAND_LETTER_CODE)

      // ...and the surviving completion, grounded in that letter-free
      // prompt+system, is itself letter-free and names pronunciation —
      // the guard and the instructions agree, and the qualifier the
      // completion uses traces to an instruction, not test-author habit.
      expect(body.narrative).not.toMatch(BARE_BAND_TOKEN)
      expect(body.wins.join(" ")).not.toMatch(BARE_BAND_TOKEN)
      expect(body.risks.join(" ")).not.toMatch(BARE_BAND_TOKEN)
      expect(body.wins.join(" ")).toMatch(/pronunciation/i)
    } finally {
      __setProviderForTest(mockProvider)
    }

    const rows = await db.select().from(programQbrs).where(eq(programQbrs.programId, programId))
    expect(rows).toHaveLength(1)
  })
})
