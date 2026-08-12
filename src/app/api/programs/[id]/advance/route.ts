import { randomUUID } from "crypto"
import { and, asc, eq, inArray, lte } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/db"
import {
  drafts as draftsTable, learners, phonemeScores, programs, programWeeks,
  sessions, utterances, wordScores,
} from "@/db/schema"
import { callWithSchema } from "@/lib/llm/adapter"
import { WEEKLY_PASS_SYSTEM_PROMPT } from "@/lib/llm/prompts"
import { MISS_THRESHOLD } from "@/lib/placement"
import { WeeklyPassSchema } from "@/lib/schemas"
import { computeWeeklyFacts, type MissedPhonemeRow, type SessionRow, type WeeklyFacts } from "@/lib/weekly"

// schemas.ts is an established interface from an earlier task (Task 6) and is
// deliberately left unmodified here — this mirrors its NO_CEFR check
// (src/lib/schemas.ts) rather than exporting a new symbol from that file, so
// the managerBrief grounding refine below can reject a stray CEFR-shaped
// token without touching schemas.ts at all.
const NO_CEFR = /\b(A1|A2|B1|B2|C1|C2|CEFR)\b/i

export const runtime = "nodejs"
export const maxDuration = 60

// This route is the only place computeWeeklyFacts (src/lib/weekly.ts, pure,
// no model import) and callWithSchema meet: facts are computed in code
// first, then handed to the model as ground truth it is instructed never to
// recompute. onTrack/slipped are, by design, never taken from the model's
// answer — see the override below.

/**
 * Grounds the model's judgement fields against this week's real cohort and
 * enforces the plain-language rule on managerBrief. Same pattern as
 * groundedPlacementsSchema in programs/generate/route.ts: a violation is a
 * schema.safeParse failure, so it flows through callWithSchema's existing
 * retry loop instead of a second bespoke retry path.
 */
function groundedWeeklyPassSchema(allowedLearnerIds: Set<string>, horizonWeeks: number) {
  return WeeklyPassSchema.superRefine((data, ctx) => {
    data.atRisk.forEach((id, i) => {
      if (!allowedLearnerIds.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["atRisk", i],
          message: `atRisk cites unknown learner "${id}" — not in this week's seeded cohort`,
        })
      }
    })
    data.drafts.forEach((d, i) => {
      if (!allowedLearnerIds.has(d.learnerId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["drafts", i, "learnerId"],
          message: `draft cites unknown learner "${d.learnerId}" — not in this week's seeded cohort`,
        })
      }
    })
    data.curriculumAdjustments.forEach((adj, i) => {
      if (!Number.isInteger(adj.weekN) || adj.weekN < 1 || adj.weekN > horizonWeeks) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["curriculumAdjustments", i, "weekN"],
          message: `curriculum adjustment targets week ${adj.weekN}, outside the program's 1..${horizonWeeks} horizon`,
        })
      }
    })
    if (NO_CEFR.test(data.managerBrief)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["managerBrief"],
        message: "managerBrief must not contain a CEFR band code — plain language only",
      })
    }
  })
}

function fmtScore(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

function buildWeeklyPassPrompt(
  weekNumber: number, horizonWeeks: number, theme: string | null, facts: WeeklyFacts,
): string {
  const completedLines = facts.completed.length
    ? facts.completed.map(c => `  ${c.learnerId}: ${c.sessions} session(s) completed`).join("\n")
    : "  (none)"
  const missedLines = facts.missed.length
    ? facts.missed.map(m => `  ${m.learnerId}: ${m.sessions} session(s) missed`).join("\n")
    : "  (none)"
  const movementLines = facts.movement.length
    ? facts.movement
        .map(m => `  ${m.learnerId}: ${fmtScore(m.from)} -> ${fmtScore(m.to)} (${m.deltaTotal >= 0 ? "+" : ""}${fmtScore(m.deltaTotal)})`)
        .join("\n")
    : "  (none)"
  const phonemeLines = facts.missedPhonemes.length
    ? facts.missedPhonemes.map(p => `  ${p.phone}: ${p.count}x`).join("\n")
    : "  (none)"

  return [
    `WEEK NUMBER: ${weekNumber}`,
    `HORIZON WEEKS: ${horizonWeeks}`,
    theme ? `WEEK THEME: ${theme}` : null,
    "",
    "The following facts were computed directly from seeded session and score",
    "data, not by you. Treat them as true. Do not recompute or contradict them.",
    "",
    "COMPLETED THIS WEEK:",
    completedLines,
    "",
    "MISSED THIS WEEK:",
    missedLines,
    "",
    "SCORE MOVEMENT (mean sentence total, previous week -> this week):",
    movementLines,
    "",
    "MOST-MISSED PHONEMES THIS WEEK:",
    phonemeLines,
    "",
    "onTrack must list exactly the learner ids under COMPLETED THIS WEEK, no more, no fewer.",
    "slipped must list exactly the learner ids under MISSED THIS WEEK, no more, no fewer.",
    "atRisk is your judgement call, based only on the facts above.",
    "Only draft a message for a learner named under MISSED THIS WEEK or with a negative score movement.",
    `Any curriculumAdjustments weekN must be between 1 and ${horizonWeeks} inclusive — never propose a week beyond the program's horizon.`,
  ].filter((line): line is string => line !== null).join("\n")
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

type RouteParams = { params: Promise<{ id: string }> }

export async function POST(_req: Request, { params }: RouteParams): Promise<Response> {
  const { id: programId } = await params

  const [program] = await db.select().from(programs).where(eq(programs.id, programId)).limit(1)
  if (!program) {
    return NextResponse.json({ error: "program not found" }, { status: 404 })
  }

  const weekNumber = program.currentWeek + 1
  if (weekNumber > program.horizonWeeks) {
    return NextResponse.json(
      {
        error:
          `Cannot advance: program is already at week ${program.currentWeek} of ` +
          `${program.horizonWeeks}. Advancing would produce week ${weekNumber}, past the horizon.`,
      },
      { status: 400 },
    )
  }

  // ---- Read the seeded facts for this week (and the one before it) ----
  const cohortLearnerRows = await db
    .select({ id: learners.id })
    .from(learners)
    .where(eq(learners.cohortId, program.cohortId))
  const learnerIds = cohortLearnerRows.map(l => l.id)
  if (learnerIds.length === 0) {
    return NextResponse.json({ error: "no learners found for this program's cohort" }, { status: 400 })
  }

  // Fix round 1, Finding 1: this used to query only weekNumber and
  // weekNumber-1, so a learner missed for BOTH of those weeks had nothing to
  // carry forward from — lastKnownTotal, rebuilt empty every call, fell
  // straight to a fabricated 0 for both rows, misrepresenting a "no data"
  // gap as a real collapse to zero. The seed's "stopped" learner arc
  // guarantees consecutive missed weeks exist in the demo cohort, so this
  // wasn't hypothetical. Fix: load this learner's ENTIRE session history
  // from week 1 through weekNumber (cheap at this scale — at most 24
  // learners x 10 weeks) and walk it forward once, so lastKnownTotal can
  // carry a real score across a gap of any width, not just one week.
  const sessionRowsDb = await db
    .select({ id: sessions.id, learnerId: sessions.learnerId, weekN: sessions.weekN, completed: sessions.completed })
    .from(sessions)
    .where(and(inArray(sessions.learnerId, learnerIds), lte(sessions.weekN, weekNumber)))
    .orderBy(asc(sessions.learnerId), asc(sessions.weekN))

  const sessionIds = sessionRowsDb.map(s => s.id)
  const uttRowsDb = sessionIds.length
    ? await db.select({ sessionId: utterances.sessionId, total: utterances.total }).from(utterances)
        .where(inArray(utterances.sessionId, sessionIds))
    : []
  const totalsBySession = new Map<string, number[]>()
  for (const u of uttRowsDb) {
    const arr = totalsBySession.get(u.sessionId) ?? []
    arr.push(u.total)
    totalsBySession.set(u.sessionId, arr)
  }

  // Sessions come back ordered learnerId asc, weekN asc within a learner, so
  // walking them in order and remembering the last computable mean per
  // learner is a correct forward carry across an arbitrary run of missed
  // weeks — not just one. A missed week (no utterances) keeps the learner's
  // last known score instead of a fabricated drop to 0, which would
  // misrepresent "didn't show up" as "scored badly." If a learner has NEVER
  // had a scored session by a given week (no carry-forward value exists
  // yet), `total` is `null` — "genuinely unknown," not a stand-in for zero.
  // computeWeeklyFacts (src/lib/weekly.ts) is what turns that null into an
  // omitted movement entry rather than a fabricated numeric one; only the
  // two weeks computeWeeklyFacts actually looks at (weekNumber and
  // weekNumber-1) end up mattering downstream, but every earlier week still
  // has to be walked here to seed lastKnownTotal correctly for those two.
  const lastKnownTotal = new Map<string, number>()
  const sessionRows: SessionRow[] = sessionRowsDb.map(s => {
    const totals = totalsBySession.get(s.id) ?? []
    let total: number | null
    if (totals.length > 0) {
      total = totals.reduce((a, b) => a + b, 0) / totals.length
      lastKnownTotal.set(s.learnerId, total)
    } else {
      total = lastKnownTotal.get(s.learnerId) ?? null
    }
    return { learnerId: s.learnerId, weekN: s.weekN, completed: s.completed, total }
  })

  const phoneRowsDb = sessionIds.length
    ? await db
        .select({ weekN: sessions.weekN, phone: phonemeScores.phone, mean: phonemeScores.mean })
        .from(phonemeScores)
        .innerJoin(wordScores, eq(phonemeScores.wordScoreId, wordScores.id))
        .innerJoin(utterances, eq(wordScores.utteranceId, utterances.id))
        .innerJoin(sessions, eq(utterances.sessionId, sessions.id))
        .where(eq(sessions.weekN, weekNumber))
    : []
  const missedPhonemeRows: MissedPhonemeRow[] = phoneRowsDb
    .filter(p => p.mean < MISS_THRESHOLD)
    .map(p => ({ weekN: p.weekN, phone: p.phone }))

  // ---- Code computes the facts. This is the only call to computeWeeklyFacts. ----
  const facts = computeWeeklyFacts(sessionRows, weekNumber, missedPhonemeRows)

  const [existingWeekRow] = await db
    .select({ id: programWeeks.id, theme: programWeeks.theme })
    .from(programWeeks)
    .where(and(eq(programWeeks.programId, programId), eq(programWeeks.n, weekNumber)))
    .limit(1)

  // ---- Model supplies judgement and wording only, over the computed facts. ----
  const allowedLearnerIds = new Set(learnerIds)
  const prompt = buildWeeklyPassPrompt(weekNumber, program.horizonWeeks, existingWeekRow?.theme ?? null, facts)

  let modelResult
  try {
    modelResult = await callWithSchema({
      system: WEEKLY_PASS_SYSTEM_PROMPT,
      prompt,
      schema: groundedWeeklyPassSchema(allowedLearnerIds, program.horizonWeeks),
      toolName: "weeklyPass",
      kind: "weekly",
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `weekly pass generation failed: ${message}` }, { status: 502 })
  }
  const modelData = modelResult.data

  // The model's arithmetic is never trusted for onTrack/slipped — those are
  // read straight off the computed facts. A mismatch is logged (it signals
  // the model didn't attend to the facts it was given) but never changes
  // what gets persisted.
  const factOnTrack = facts.completed.map(c => c.learnerId)
  const factSlipped = facts.missed.map(m => m.learnerId)
  const onTrackMismatch = !setsEqual(new Set(factOnTrack), new Set(modelData.onTrack))
  const slippedMismatch = !setsEqual(new Set(factSlipped), new Set(modelData.slipped))
  if (onTrackMismatch || slippedMismatch) {
    console.warn(
      `advance program ${programId} week ${weekNumber}: model's onTrack/slipped did not match ` +
        `computed completion facts (onTrackMismatch=${onTrackMismatch}, slippedMismatch=${slippedMismatch}); ` +
        "persisting the computed values, not the model's.",
    )
  }

  // ---- Persist ----
  if (existingWeekRow) {
    await db.update(programWeeks).set({
      managerBrief: modelData.managerBrief,
      onTrack: factOnTrack,
      slipped: factSlipped,
      atRisk: modelData.atRisk,
      adjustments: modelData.curriculumAdjustments,
      advancedAt: new Date(),
    }).where(eq(programWeeks.id, existingWeekRow.id))
  } else {
    // Edge case: the generated curriculum had fewer weeks than horizonWeeks,
    // so no programWeeks row exists yet for this n. Create one rather than
    // silently dropping the weekly pass.
    await db.insert(programWeeks).values({
      id: randomUUID(),
      programId,
      n: weekNumber,
      theme: `Week ${weekNumber}`,
      managerBrief: modelData.managerBrief,
      onTrack: factOnTrack,
      slipped: factSlipped,
      atRisk: modelData.atRisk,
      adjustments: modelData.curriculumAdjustments,
      advancedAt: new Date(),
    })
  }

  if (modelData.drafts.length > 0) {
    await db.insert(draftsTable).values(modelData.drafts.map(d => ({
      id: randomUUID(),
      programId,
      weekN: weekNumber,
      learnerId: d.learnerId,
      channel: d.channel,
      subject: d.subject,
      body: d.body,
      reason: d.reason,
      status: "draft" as const, // never auto-sent — see AGENTS.md / task brief
    })))
  }

  await db.update(programs).set({ currentWeek: weekNumber }).where(eq(programs.id, programId))

  return NextResponse.json({
    programId,
    weekNumber,
    currentWeek: weekNumber,
    facts,
    managerBrief: modelData.managerBrief,
    onTrack: factOnTrack,
    slipped: factSlipped,
    atRisk: modelData.atRisk,
    curriculumAdjustments: modelData.curriculumAdjustments,
    draftsCreated: modelData.drafts.length,
  })
}
