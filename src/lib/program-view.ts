import { and, asc, eq, inArray, lte } from "drizzle-orm"
import { db } from "@/db"
import {
  drafts as draftsTable, learners, programs, programWeeks, sessions, utterances,
} from "@/db/schema"
import { computeWeeklyFacts, type SessionRow } from "@/lib/weekly"

// Read-side query layer for the program overview and Monday-brief pages —
// the same role evidence.ts plays for the placement drawer. Every DB read
// either page needs flows through one of the two functions below, so there
// is exactly one join per shape to keep correct, not a copy sitting inside
// each page component.

export type ProgramWeekSummary = {
  n: number
  theme: string
  advancedAt: string | null
}

export type TrajectoryPoint = {
  weekN: number
  meanTotal: number
}

export type ProgramOverview = {
  id: string
  brief: string
  currentWeek: number
  horizonWeeks: number
  weeks: ProgramWeekSummary[]
  trajectory: TrajectoryPoint[]
}

/**
 * Loads every seeded session row for a set of learners, through (and
 * including) `throughWeek`, each carrying that session's mean utterance
 * `total` — with a missed week (no utterances) carrying the learner's last
 * KNOWN total forward rather than a fabricated 0, and `null` when nothing
 * has ever been scored yet. This is the same read POST
 * /api/programs/[id]/advance/route.ts performs before calling
 * computeWeeklyFacts (src/lib/weekly.ts).
 *
 * Deliberately duplicated here rather than imported from that route: a
 * route file's POST handler isn't a library export, and that route is a
 * reviewed, frozen Task-11 surface this task must not touch. Kept small and
 * isolated to this one read path rather than threaded through a shared
 * helper that would require editing the advance route too.
 */
async function loadSessionRows(learnerIds: string[], throughWeek: number): Promise<SessionRow[]> {
  if (learnerIds.length === 0 || throughWeek < 1) return []

  const sessionRowsDb = await db
    .select({ id: sessions.id, learnerId: sessions.learnerId, weekN: sessions.weekN, completed: sessions.completed })
    .from(sessions)
    .where(and(inArray(sessions.learnerId, learnerIds), lte(sessions.weekN, throughWeek)))
    .orderBy(asc(sessions.learnerId), asc(sessions.weekN))

  const sessionIds = sessionRowsDb.map(s => s.id)
  const uttRowsDb = sessionIds.length
    ? await db
        .select({ sessionId: utterances.sessionId, total: utterances.total })
        .from(utterances)
        .where(inArray(utterances.sessionId, sessionIds))
    : []
  const totalsBySession = new Map<string, number[]>()
  for (const u of uttRowsDb) {
    const arr = totalsBySession.get(u.sessionId) ?? []
    arr.push(u.total)
    totalsBySession.set(u.sessionId, arr)
  }

  // Sessions come back ordered learnerId asc, weekN asc within a learner —
  // walking them in order and carrying the last computable mean forward per
  // learner correctly spans a gap of any width, mirroring the advance route.
  const lastKnownTotal = new Map<string, number>()
  return sessionRowsDb.map(s => {
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
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export async function getProgramOverview(programId: string): Promise<ProgramOverview | null> {
  const [program] = await db.select().from(programs).where(eq(programs.id, programId)).limit(1)
  if (!program) return null

  const weekRows = await db
    .select({ n: programWeeks.n, theme: programWeeks.theme, advancedAt: programWeeks.advancedAt })
    .from(programWeeks)
    .where(eq(programWeeks.programId, programId))
    .orderBy(asc(programWeeks.n))

  const weeks: ProgramWeekSummary[] = weekRows.map(w => ({
    n: w.n,
    theme: w.theme,
    advancedAt: w.advancedAt ? w.advancedAt.toISOString() : null,
  }))

  // Trajectory: cohort mean sentence `total`, week by week, through
  // currentWeek. This is exactly the "one session per speaker, ordered into
  // a trajectory" construction the honesty banner already discloses —
  // SimulatedTag marks it again at the point of the claim on the program
  // page, per the standing project constraint.
  const learnerRows = await db
    .select({ id: learners.id })
    .from(learners)
    .where(eq(learners.cohortId, program.cohortId))
  const learnerIds = learnerRows.map(l => l.id)
  const sessionRows = await loadSessionRows(learnerIds, program.currentWeek)

  const sumByWeek = new Map<number, { sum: number; n: number }>()
  for (const r of sessionRows) {
    if (r.total === null) continue
    const cur = sumByWeek.get(r.weekN) ?? { sum: 0, n: 0 }
    cur.sum += r.total
    cur.n += 1
    sumByWeek.set(r.weekN, cur)
  }
  const trajectory: TrajectoryPoint[] = [...sumByWeek.entries()]
    .map(([weekN, { sum, n }]) => ({ weekN, meanTotal: round2(sum / n) }))
    .sort((a, b) => a.weekN - b.weekN)

  return {
    id: program.id,
    brief: program.brief,
    currentWeek: program.currentWeek,
    horizonWeeks: program.horizonWeeks,
    weeks,
    trajectory,
  }
}

// `name`/`role` are null only when a learnerId cited in a persisted array
// (onTrack/slipped/atRisk, or a draft) doesn't resolve to a learners row —
// unreachable today given the schema's NOT NULL FKs, but never papered over
// with a fabricated name (same convention as evidence.ts's `learner: null`).
export type WeekBriefLearner = { id: string; name: string | null; role: string | null }

export type DraftView = {
  id: string
  learnerId: string
  learner: WeekBriefLearner
  channel: "email" | "slack"
  subject: string
  body: string
  editedBody: string | null
  reason: string
  status: "draft" | "approved"
}

export type MovementEntry = {
  learnerId: string
  learner: WeekBriefLearner
  from: number
  to: number
  deltaTotal: number
}

export type WeekBriefData = {
  programId: string
  n: number
  theme: string
  managerBrief: string | null
  // Counters (build guide §7) are the .length of these — read straight off
  // the persisted arrays computeWeeklyFacts produced, never recounted from
  // a different source. `learners` alongside each is display-only.
  onTrack: WeekBriefLearner[]
  slipped: WeekBriefLearner[]
  atRisk: WeekBriefLearner[]
  adjustments: { weekN: number; change: string; reason: string }[]
  advancedAt: string
  movement: MovementEntry[]
  drafts: DraftView[]
}

export type WeekBriefResult =
  | { status: "program_not_found" }
  | { status: "week_not_found" } // n outside this program's curriculum entirely
  | { status: "not_advanced"; programId: string; n: number; theme: string; currentWeek: number; horizonWeeks: number }
  | { status: "ready"; data: WeekBriefData }

async function learnersByIds(ids: string[]): Promise<Map<string, WeekBriefLearner>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({ id: learners.id, name: learners.name, role: learners.role })
    .from(learners)
    .where(inArray(learners.id, ids))
  return new Map(rows.map(r => [r.id, r]))
}

function toDisplayList(ids: string[], byId: Map<string, WeekBriefLearner>): WeekBriefLearner[] {
  return ids.map(id => byId.get(id) ?? { id, name: null, role: null })
}

export async function getWeekBrief(programId: string, n: number): Promise<WeekBriefResult> {
  const [program] = await db.select().from(programs).where(eq(programs.id, programId)).limit(1)
  if (!program) return { status: "program_not_found" }

  const [week] = await db
    .select()
    .from(programWeeks)
    .where(and(eq(programWeeks.programId, programId), eq(programWeeks.n, n)))
    .limit(1)

  // No row for this n at all is NOT automatically "this week doesn't exist."
  // Curriculum generation persists one programWeeks row per THEME the model
  // produced (Task 9), and the advance route separately creates a row keyed
  // by sequential weekNumber (currentWeek + 1) if one isn't already there
  // for that n (see its "Edge case" comment) — the two numberings aren't
  // guaranteed to line up, so a real program can easily have no row yet for
  // an n that is still well within its horizon. Ambiguity resolution is
  // explicit: a week that hasn't been advanced must render a clear
  // "not advanced" state and an offer to advance, never a 404 — that only
  // holds if a missing row within 1..horizonWeeks is treated the same as a
  // row that exists but has no advancedAt. A 404 is reserved for n truly
  // outside this program's horizon.
  if (!week) {
    if (n < 1 || n > program.horizonWeeks) return { status: "week_not_found" }
    return {
      status: "not_advanced",
      programId,
      n,
      theme: `Week ${n}`,
      currentWeek: program.currentWeek,
      horizonWeeks: program.horizonWeeks,
    }
  }

  if (!week.advancedAt) {
    return {
      status: "not_advanced",
      programId,
      n,
      theme: week.theme,
      currentWeek: program.currentWeek,
      horizonWeeks: program.horizonWeeks,
    }
  }

  const onTrackIds = (week.onTrack as string[] | null) ?? []
  const slippedIds = (week.slipped as string[] | null) ?? []
  const atRiskIds = (week.atRisk as string[] | null) ?? []
  const adjustments = (week.adjustments as { weekN: number; change: string; reason: string }[] | null) ?? []

  const draftRows = await db
    .select()
    .from(draftsTable)
    .where(and(eq(draftsTable.programId, programId), eq(draftsTable.weekN, n)))

  const learnerRows = await db
    .select({ id: learners.id })
    .from(learners)
    .where(eq(learners.cohortId, program.cohortId))
  const cohortLearnerIds = learnerRows.map(l => l.id)
  const sessionRows = await loadSessionRows(cohortLearnerIds, n)
  const facts = computeWeeklyFacts(sessionRows, n)

  const neededIds = [
    ...new Set([...onTrackIds, ...slippedIds, ...atRiskIds, ...draftRows.map(d => d.learnerId), ...facts.movement.map(m => m.learnerId)]),
  ]
  const learnerMap = await learnersByIds(neededIds)

  const drafts: DraftView[] = draftRows.map(d => ({
    id: d.id,
    learnerId: d.learnerId,
    learner: learnerMap.get(d.learnerId) ?? { id: d.learnerId, name: null, role: null },
    channel: d.channel as "email" | "slack",
    subject: d.subject,
    body: d.body,
    editedBody: d.editedBody,
    reason: d.reason,
    status: d.status as "draft" | "approved",
  }))

  const movement: MovementEntry[] = facts.movement.map(m => ({
    learnerId: m.learnerId,
    learner: learnerMap.get(m.learnerId) ?? { id: m.learnerId, name: null, role: null },
    from: m.from,
    to: m.to,
    deltaTotal: m.deltaTotal,
  }))

  return {
    status: "ready",
    data: {
      programId,
      n,
      theme: week.theme,
      managerBrief: week.managerBrief,
      onTrack: toDisplayList(onTrackIds, learnerMap),
      slipped: toDisplayList(slippedIds, learnerMap),
      atRisk: toDisplayList(atRiskIds, learnerMap),
      adjustments,
      advancedAt: week.advancedAt.toISOString(),
      movement,
      drafts,
    },
  }
}
