import { randomUUID } from "crypto"
import { and, asc, eq, inArray, lte } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/db"
import { BANDS } from "@/lib/bands"
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

// Fix round 1, Finding 3: this used to interpolate literal band letters
// (m.startBand / m.endBand, e.g. "B1 -> B2") straight into the prompt, while
// the trailing instruction told the model to "cite a specific number or
// named trend" — and groundedQbrSchema's CEFR guard rejects any bare
// A1/A2/B1/B2/C1 token anywhere in the model's output. A model that followed
// the "cite a trend" instruction using the exact vocabulary it was just
// shown ("moved from B1 to B2") would fail its own grounding check. Bare
// numeric levels (1..5, via BANDS.indexOf) close this at the source: the
// model is never shown a letter code for band movement at all, so there is
// nothing letter-shaped to echo back. The QBR page itself still renders the
// real A1-C1 letters for a human reader (BandMovementTable in page.tsx) —
// only the text handed to the model avoids them.
//
// Fix round 2, Finding A: a bare "level" is not self-explanatory — nothing
// told the model what a level MEANS, so a real completion could plausibly
// write "3 learners moved up a level" with no indication this is about
// pronunciation at all, which is more opaque than the letters were, not
// less. The BAND MOVEMENT header below and QBR_SYSTEM_PROMPT both now say
// explicitly that levels are derived from pronunciation-accuracy scores
// (1 = least accurate, 5 = most) and instruct the model to name
// pronunciation explicitly when it describes movement.
function bandLevel(band: QbrFacts["bandMovement"]["perLearner"][number]["startBand"]): number {
  return BANDS.indexOf(band) + 1
}

function fmtBandMovement(facts: QbrFacts): string {
  if (facts.bandMovement.perLearner.length === 0) return "  (no learner has a comparable first/last score yet)"
  return facts.bandMovement.perLearner
    .map(m => `  ${m.name}: level ${bandLevel(m.startBand)} -> level ${bandLevel(m.endBand)} (${m.direction})`)
    .join("\n")
}

// Fix round 1, Finding 3 (continued) / Fix round 2, Finding B: the
// per-request text this function builds — everything in `prompt`, facts
// AND instructions — is kept 100% free of literal band letters. No
// A1/A2/B1/B2/C1 appears anywhere below, not even as a "don't write this"
// negative example: an early version of the trailing instruction spelled
// those out as an example of what not to write, which put a bare
// band-shaped token back into the prompt sent to the model — caught by this
// route's own test suite (route.test.ts), which asserts `prompt` is
// letter-free.
//
// QBR_SYSTEM_PROMPT (src/lib/llm/prompts.ts) is the other half of what the
// provider actually receives (`provider.call({ system, prompt })` — two
// separate fields, not one). Round 1's report overstated coverage by
// calling the combined result "the entire prompt text," when only `prompt`
// (this function's output) had been checked; `system` still isn't part of
// what THIS function builds, but round 2 closed the same gap in it — its
// negative example now describes the forbidden SHAPE ("one capital letter
// directly followed by one digit") instead of listing literal instances
// like "A1"/"B2". `system` is a narrower claim than `prompt`, though, not
// an identical one: it still names "CEFR" as a concept in fixed,
// instructional text ("not CEFR proficiency assessments"), which is
// deliberately allowed — see BAND_LETTER_CODE's comment in route.test.ts
// for why that's a different thing from a letter-digit code appearing as
// if it were ground truth to cite. Both fields are asserted independently
// in route.test.ts, against the regex that actually matches each claim.
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
    // Fix round 2, Finding A: "level 1-5" alone has no semantic anchor — a
    // real completion could plausibly write "3 learners moved up a level"
    // with nothing tying that to pronunciation at all. This header now says
    // what a level IS (derived from expert pronunciation-accuracy scores,
    // 1 = least accurate, 5 = most) so the model has something concrete to
    // ground its plain-language description in, matching QBR_SYSTEM_PROMPT's
    // rule to name pronunciation explicitly.
    "BAND MOVEMENT (level 1-5, derived from expert pronunciation-accuracy",
    "scores — 1 = least accurate pronunciation in this cohort, 5 = most;",
    "first known score -> most recent known score, this quarter):",
    `  up ${facts.bandMovement.up}, down ${facts.bandMovement.down}, unchanged ${facts.bandMovement.same}`,
    fmtBandMovement(facts),
    "",
    "MOST IMPROVED (largest gain in composite session score this quarter):",
    mostImprovedLines,
    "",
    "CURRENTLY AT RISK:",
    atRiskLines,
    "",
    "Write the QBR from these facts only. wins and risks must each cite a",
    "specific number or named trend above. When citing band movement, name",
    "pronunciation explicitly and describe it in plain language a manager",
    "understands — \"moved up a level in pronunciation accuracy\", \"held",
    "steady on pronunciation this quarter\" — never as a letter-and-number",
    "code. See your system instructions for the exact forbidden shape and why.",
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
