import { randomUUID } from "crypto"
import { describe, it, expect, beforeAll } from "vitest"
import { db } from "@/db"
import { programs, programWeeks } from "@/db/schema"
import { loadCohortId } from "@/lib/placement"
import { getProgramOverview, getWeekBrief } from "./program-view"

// Fix round 1 on Task 12, Finding 1 / Finding 2 regression guard. Reproduces,
// with rows inserted directly (no LLM call, no cost), exactly the shape of
// corruption the live review found: a programWeeks row whose n is a
// duplicate of another row's, AND a row whose n falls outside the program's
// own 1..horizonWeeks. Both of those are real, reachable states — Finding 1
// showed the mock provider's old number generator produced them for
// essentially every freshly generated program regardless of horizon, and
// nothing in CurriculumSchema stopped a real model from doing the same.

let cohortId: string

beforeAll(async () => {
  cohortId = await loadCohortId()
})

async function makeProgram(horizonWeeks: number, currentWeek = 0): Promise<string> {
  const id = randomUUID()
  await db.insert(programs).values({
    id,
    cohortId,
    brief: `program-view-test-${id}`,
    horizonWeeks,
    currentWeek,
  })
  return id
}

async function insertWeekRow(
  programId: string,
  n: number,
  theme: string,
  advancedAt: Date | null = null,
): Promise<void> {
  await db.insert(programWeeks).values({ id: randomUUID(), programId, n, theme, advancedAt })
}

describe("getProgramOverview — tile list is always exactly 1..horizonWeeks", () => {
  it("renders exactly horizonWeeks tiles, numbered 1..horizonWeeks, even with a duplicate AND an out-of-range n in the table", async () => {
    const programId = await makeProgram(3)

    // Out-of-range duplicate, exactly like the live-reproduced case: two
    // rows sharing n=5 on a 3-week-horizon program, neither of which is
    // reachable through 1..3.
    await insertWeekRow(programId, 5, "mock-theme-a")
    await insertWeekRow(programId, 5, "mock-theme-b")
    // A real, in-range, advanced week — must still show up correctly.
    await insertWeekRow(programId, 2, "Real week 2 theme", new Date("2026-01-05T00:00:00.000Z"))
    // Week 1 and week 3 have no row at all.

    const overview = await getProgramOverview(programId)
    expect(overview).not.toBeNull()
    if (!overview) return

    expect(overview.weeks).toHaveLength(3)
    expect(overview.weeks.map(w => w.n)).toEqual([1, 2, 3])

    // No dead-end n=5 tile anywhere in the result.
    expect(overview.weeks.some(w => w.n === 5)).toBe(false)

    const [wk1, wk2, wk3] = overview.weeks
    expect(wk1.theme).toBe("Week 1")
    expect(wk1.advancedAt).toBeNull()
    expect(wk2.theme).toBe("Real week 2 theme")
    expect(wk2.advancedAt).toBe("2026-01-05T00:00:00.000Z")
    expect(wk3.theme).toBe("Week 3")
    expect(wk3.advancedAt).toBeNull()
  })

  it("picks the advanced row as canonical when a duplicate in-range n has one advanced and one not", async () => {
    const programId = await makeProgram(2)

    await insertWeekRow(programId, 1, "Draft version, never advanced")
    await insertWeekRow(programId, 1, "Real week 1", new Date("2026-01-01T00:00:00.000Z"))

    const overview = await getProgramOverview(programId)
    expect(overview).not.toBeNull()
    if (!overview) return

    expect(overview.weeks).toHaveLength(2)
    expect(overview.weeks[0].theme).toBe("Real week 1")
    expect(overview.weeks[0].advancedAt).toBe("2026-01-01T00:00:00.000Z")
  })
})

describe("getWeekBrief — canonical row selection agrees with getProgramOverview", () => {
  it("resolves the advanced duplicate deterministically, not by table scan order", async () => {
    const programId = await makeProgram(2, 1)

    await insertWeekRow(programId, 1, "Draft version, never advanced")
    await insertWeekRow(programId, 1, "Real week 1", new Date("2026-01-01T00:00:00.000Z"))

    const result = await getWeekBrief(programId, 1)
    expect(result.status).toBe("ready")
    if (result.status !== "ready") return
    expect(result.data.theme).toBe("Real week 1")
  })

  it("treats an out-of-range n as not found (a real 404), never as 'not advanced'", async () => {
    const programId = await makeProgram(3)
    await insertWeekRow(programId, 5, "mock-theme-a")
    await insertWeekRow(programId, 5, "mock-theme-b")

    const result = await getWeekBrief(programId, 5)
    expect(result.status).toBe("week_not_found")
  })

  it("treats an in-range n with no row at all as 'not advanced', never 404", async () => {
    const programId = await makeProgram(3)
    // No programWeeks rows at all for this program.

    const result = await getWeekBrief(programId, 2)
    expect(result.status).toBe("not_advanced")
  })
})
