import { randomUUID } from "crypto"
import { and, asc, eq, inArray, lte } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/db"
import { learners, programQbrs, programs, programWeeks, sessions, utterances } from "@/db/schema"
import { callWithSchema } from "@/lib/llm/adapter"
import { QBR_SYSTEM_PROMPT } from "@/lib/llm/prompts"
import { computeQbrFacts, type QbrFacts } from "@/lib/qbr"
import { QbrSchema } from "@/lib/schemas"
import type { SessionRow } from "@/lib/weekly"

// This route is the QBR's equivalent of the weekly-pass route: computeQbrFacts
// (src/lib/qbr.ts, pure, no adapter import) runs first over real seeded data,
// and the model receives the result as ground truth it is instructed never to
// recompute. Every number on the printed page traces back to this facts
// object — the model supplies headline/narrative/wins/risks/recommendation
// only, never a figure.

const NO_CEFR = /\b(A1|A2|B1|B2|C1|C2|CEFR)\b/i

export const runtime = "nodejs"
export const maxDuration = 60

function fmtScore(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

/**
 * Loads every seeded session row for a cohort through `throughWeek`, twice
 * over — once carrying forward mean `total` per session, once carrying
 * forward mean `accuracy` per session, both using the identical "hold the
 * last known value across a missed week" walk the advance route and
 * program-view.ts already use for `total`. Deliberately duplicated here
 * rather than imported, same reasoning program-view.ts gives for
 * duplicating its own copy: this is one isolated read path, not a shared
 * helper that would require touching two reviewed, frozen routes.
 *
 * Two independent carry-forwards (not one query reused for both) because
 * they feed dimensionally different facts downstream — see the comment on
 * computeQbrFacts in src/lib/qbr.ts for why `total` and `accuracy` must
 * never be conflated for band classification.
 */
async function loadQbrSessionRows(
  learnerIds: string[],
  throughWeek: number,
): Promise<{ totalRows: SessionRow[]; accuracyRows: SessionRow[] }> {
  if (learnerIds.length === 0 || throughWeek < 1) return { totalRows: [], accuracyRows: [] }

  const sessionRowsDb = await db
    .select({ id: sessions.id, learnerId: sessions.learnerId, weekN: sessions.weekN, completed: sessions.completed })
    .from(sessions)
    .where(and(inArray(sessions.learnerId, learnerIds), lte(sessions.weekN, throughWeek)))
    .orderBy(asc(sessions.learnerId), asc(sessions.weekN))

  const sessionIds = sessionRowsDb.map(s => s.id)
  const uttRowsDb = sessionIds.length
    ? await db
        .select({ sessionId: utterances.sessionId, total: utterances.total, accuracy: utterances.accuracy })
        .from(utterances)
        .where(inArray(utterances.sessionId, sessionIds))
    : []

  const totalsBySession = new Map<string, number[]>()
  const accuraciesBySession = new Map<string, number[]>()
  for (const u of uttRowsDb) {
    const tArr = totalsBySession.get(u.sessionId) ?? []
    tArr.push(u.total)
    totalsBySession.set(u.sessionId, tArr)
    const aArr = accuraciesBySession.get(u.sessionId) ?? []
    aArr.push(u.accuracy)
    accuraciesBySession.set(u.sessionId, aArr)
  }

  const lastKnownTotal = new Map<string, number>()
  const lastKnownAccuracy = new Map<string, number>()
  const totalRows: SessionRow[] = []
  const accuracyRows: SessionRow[] = []

  for (const s of sessionRowsDb) {
    const totals = totalsBySession.get(s.id) ?? []
    let total: number | null
    if (totals.length > 0) {
      total = totals.reduce((a, b) => a + b, 0) / totals.length
      lastKnownTotal.set(s.learnerId, total)
    } else {
      total = lastKnownTotal.get(s.learnerId) ?? null
    }
    totalRows.push({ learnerId: s.learnerId, weekN: s.weekN, completed: s.completed, total })

    const accuracies = accuraciesBySession.get(s.id) ?? []
    let accuracy: number | null
    if (accuracies.length > 0) {
      accuracy = accuracies.reduce((a, b) => a + b, 0) / accuracies.length
      lastKnownAccuracy.set(s.learnerId, accuracy)
    } else {
      accuracy = lastKnownAccuracy.get(s.learnerId) ?? null
    }
    accuracyRows.push({ learnerId: s.learnerId, weekN: s.weekN, completed: s.completed, total: accuracy })
  }

  return { totalRows, accuracyRows }
}

function fmtBandMovement(facts: QbrFacts): string {
  if (facts.bandMovement.perLearner.length === 0) return "  (no learner has a comparable first/last score yet)"
  return facts.bandMovement.perLearner
    .map(m => `  ${m.name}: ${m.startBand} -> ${m.endBand} (${m.direction})`)
    .join("\n")
}

function buildQbrPrompt(programBrief: string, facts: QbrFacts): string {
  const mostImprovedLines = facts.mostImproved.length
    ? facts.mostImproved
        .map(m => `  ${m.name}: ${fmtScore(m.from)} -> ${fmtScore(m.to)} (+${fmtScore(m.deltaTotal)})`)
        .join("\n")
    : "  (no learner improved over this window)"
  const atRiskLines = facts.atRisk.length
    ? facts.atRisk.map(a => `  ${a.name}`).join("\n")
    : "  (none currently flagged)"

  return [
    `PROGRAM BRIEF: ${programBrief}`,
    `QUARTER TO DATE: week ${facts.weeksCompleted} of ${facts.horizonWeeks}`,
    `COHORT SIZE: ${facts.cohortSize} learners`,
    "",
    "The following facts were computed directly from seeded session and score",
    "data, not by you. Treat them as true. Do not recompute or contradict them.",
    "",
    "COMPLETION:",
    `  ${facts.completion.completedSessions} of ${facts.completion.totalSessions} sessions completed (${fmtScore(facts.completion.ratePct)}%)`,
    "",
    "BAND MOVEMENT (first known score -> most recent known score, this quarter):",
    `  up ${facts.bandMovement.up}, down ${facts.bandMovement.down}, unchanged ${facts.bandMovement.same}`,
    fmtBandMovement(facts),
    "",
    "MOST IMPROVED (largest score gain this quarter):",
    mostImprovedLines,
    "",
    "CURRENTLY AT RISK:",
    atRiskLines,
    "",
    "Write the QBR from these facts only. wins and risks must each cite a",
    "specific number or named trend above. Never mention CEFR — the band",
    "labels here are pronunciation-derived proxies, not CEFR levels.",
  ].join("\n")
}

/** Same CEFR-guard pattern as the weekly pass route's managerBrief check — a
 * violation is a schema.safeParse failure, so it flows through
 * callWithSchema's existing retry loop instead of a bespoke one. */
function groundedQbrSchema() {
  return QbrSchema.superRefine((data, ctx) => {
    const textFields: [string, string][] = [
      ["headline", data.headline],
      ["narrative", data.narrative],
      ["recommendation", data.recommendation],
      ...data.wins.map((w, i): [string, string] => [`wins[${i}]`, w]),
      ...data.risks.map((r, i): [string, string] => [`risks[${i}]`, r]),
    ]
    for (const [path, text] of textFields) {
      if (NO_CEFR.test(text)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: `${path} must not contain a CEFR band code — plain language only`,
        })
      }
    }
  })
}

type RouteParams = { params: Promise<{ id: string }> }

export async function POST(_req: Request, { params }: RouteParams): Promise<Response> {
  const { id: programId } = await params

  const [program] = await db.select().from(programs).where(eq(programs.id, programId)).limit(1)
  if (!program) {
    return NextResponse.json({ error: "program not found" }, { status: 404 })
  }

  // Ambiguity resolution (Task 14): a program with no weeks advanced has no
  // quarter to review. Refuse clearly rather than narrating an empty one.
  if (program.currentWeek < 1) {
    return NextResponse.json(
      { error: "Cannot generate a QBR: no weeks have been completed yet for this program." },
      { status: 400 },
    )
  }

  const cohortLearnerRows = await db
    .select({ id: learners.id, name: learners.name, role: learners.role })
    .from(learners)
    .where(eq(learners.cohortId, program.cohortId))
  if (cohortLearnerRows.length === 0) {
    return NextResponse.json({ error: "no learners found for this program's cohort" }, { status: 400 })
  }
  const learnerIds = cohortLearnerRows.map(l => l.id)

  const { totalRows, accuracyRows } = await loadQbrSessionRows(learnerIds, program.currentWeek)

  // atRiskIds come from the most recently advanced week's persisted
  // programWeeks row — same canonical-row ordering (advancedAt asc, id asc)
  // program-view.ts uses, so this never disagrees with what the week page
  // itself shows as "at risk" for that week.
  const [latestWeekRow] = await db
    .select({ atRisk: programWeeks.atRisk })
    .from(programWeeks)
    .where(and(eq(programWeeks.programId, programId), eq(programWeeks.n, program.currentWeek)))
    .orderBy(asc(programWeeks.advancedAt), asc(programWeeks.id))
    .limit(1)
  const atRiskIds = (latestWeekRow?.atRisk as string[] | null) ?? []

  // ---- Code computes the facts. This is the only call to computeQbrFacts. ----
  const facts = computeQbrFacts({
    totalRows,
    accuracyRows,
    learners: cohortLearnerRows,
    horizonWeeks: program.horizonWeeks,
    weeksCompleted: program.currentWeek,
    atRiskIds,
  })

  const prompt = buildQbrPrompt(program.brief, facts)

  let modelResult
  try {
    modelResult = await callWithSchema({
      system: QBR_SYSTEM_PROMPT,
      prompt,
      schema: groundedQbrSchema(),
      toolName: "qbr",
      kind: "qbr",
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `QBR generation failed: ${message}` }, { status: 502 })
  }
  const modelData = modelResult.data

  // ---- Persist: one row per program, upserted rather than accumulated —
  // "persist rather than regenerate on every page load" (Task 14's ambiguity
  // resolution). facts is stored verbatim alongside the narrative so a
  // reload never needs to recompute cohort arithmetic to render. ----
  const [existing] = await db
    .select({ id: programQbrs.id })
    .from(programQbrs)
    .where(eq(programQbrs.programId, programId))
    .limit(1)

  const row = {
    weeksCompleted: program.currentWeek,
    headline: modelData.headline,
    narrative: modelData.narrative,
    wins: modelData.wins,
    risks: modelData.risks,
    recommendation: modelData.recommendation,
    facts,
    generatedAt: new Date(),
  }

  if (existing) {
    await db.update(programQbrs).set(row).where(eq(programQbrs.id, existing.id))
  } else {
    await db.insert(programQbrs).values({ id: randomUUID(), programId, ...row })
  }

  return NextResponse.json({
    programId,
    weeksCompleted: program.currentWeek,
    horizonWeeks: program.horizonWeeks,
    facts,
    headline: modelData.headline,
    narrative: modelData.narrative,
    wins: modelData.wins,
    risks: modelData.risks,
    recommendation: modelData.recommendation,
  })
}
