import { and, asc, desc, eq, inArray, lte } from "drizzle-orm"
import { db } from "@/db"
import {
  drafts as draftsTable, learners, programQbrs, programs, programWeeks, sessions, utterances,
} from "@/db/schema"
import type { QbrFacts } from "@/lib/qbr"
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

  // Fix round 1 on Task 12, Finding 1(a): programWeeks rows are NOT
  // trustworthy as "the tile list" on their own. Curriculum generation
  // persists one row per model-authored week (Task 9), the advance route
  // separately creates one keyed by sequential weekNumber if none exists yet
  // for that n (its own documented "edge case"), and — demonstrated live in
  // review — the model/mock's own `n` numbering can duplicate and/or land
  // outside 1..horizonWeeks. Generation now renumbers sequentially at
  // persist time (see programs/generate/route.ts) and the mock provider no
  // longer collides (mock.ts), but existing rows created before that fix
  // are still in the DB, and nothing stops a future write path from
  // reintroducing the same shape of bug — so this read path defends against
  // duplicate/out-of-range rows unconditionally, not just for one dataset
  // instance. Ordered `advancedAt` first (Postgres default: ASC sorts NULLs
  // last) then `id` so which row wins a duplicate-n collision is 100%
  // deterministic — an advanced row always beats a not-advanced duplicate,
  // and ties break the same way every time. getWeekBrief applies the exact
  // same ordering (Finding 2) so the two functions never disagree about
  // which row is canonical for a given n.
  const weekRows = await db
    .select({ n: programWeeks.n, theme: programWeeks.theme, advancedAt: programWeeks.advancedAt })
    .from(programWeeks)
    .where(eq(programWeeks.programId, programId))
    .orderBy(asc(programWeeks.advancedAt), asc(programWeeks.id))

  const canonicalByN = new Map<number, { theme: string; advancedAt: Date | null }>()
  for (const w of weekRows) {
    if (!canonicalByN.has(w.n)) canonicalByN.set(w.n, { theme: w.theme, advancedAt: w.advancedAt })
  }

  // The tile list is ALWAYS exactly 1..horizonWeeks — never the raw
  // distinct-n count off the table, which could be short (a missing row) or
  // long (a duplicate/out-of-range row) of that. A row present for n is
  // used; a missing n synthesizes the identical "not advanced yet"
  // placeholder getWeekBrief's own missing-row branch falls back to, so the
  // two stay consistent with each other.
  const weeks: ProgramWeekSummary[] = Array.from({ length: program.horizonWeeks }, (_, i) => {
    const n = i + 1
    const row = canonicalByN.get(n)
    return {
      n,
      theme: row?.theme ?? `Week ${n}`,
      advancedAt: row?.advancedAt ? row.advancedAt.toISOString() : null,
    }
  })

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

  // Fix round 1 on Task 12, Finding 1(a) gap found while writing the
  // regression test: the range check used to live ONLY in the "no row
  // found" branch below, so a stray row that exists for an out-of-range n
  // (exactly the n=5-on-a-3-week-horizon shape Finding 1 reproduced) would
  // still resolve through the query below and render as "not advanced yet"
  // — a week that can never actually be reached by advancing, since the
  // advance route only ever creates rows at sequential weekNumber <=
  // horizonWeeks. Checking the range unconditionally, before the row is
  // even queried, means a stray out-of-range row can no longer be reached
  // through this function at all, regardless of whether one exists.
  if (n < 1 || n > program.horizonWeeks) return { status: "week_not_found" }

  // Fix round 1 on Task 12, Finding 2: this used to be `.limit(1)` with no
  // ORDER BY — with duplicate rows sharing an n (which existed in the DB at
  // review time, and Finding 1 shows how they get created), which row
  // Postgres happened to scan first was undefined, so an advanced week could
  // intermittently render as "not advanced," or show a different row's
  // theme/adjustments, on every request. Same ordering as
  // getProgramOverview's canonicalByN (advancedAt asc — NULLs last by
  // Postgres default — then id asc) so the two functions always agree on
  // which row is canonical for a given n, deterministically, every time.
  const [week] = await db
    .select()
    .from(programWeeks)
    .where(and(eq(programWeeks.programId, programId), eq(programWeeks.n, n)))
    .orderBy(asc(programWeeks.advancedAt), asc(programWeeks.id))
    .limit(1)

  // No row for this n at all is NOT automatically "this week doesn't exist"
  // — `n` is already confirmed in range by the guard above. Curriculum
  // generation persists one programWeeks row per model-authored week (Task
  // 9), and the advance route separately creates a row keyed by sequential
  // weekNumber (currentWeek + 1) if one isn't already there for that n (see
  // its "Edge case" comment) — the two numberings aren't guaranteed to line
  // up, so a real program can easily have no row yet for an n that is still
  // well within its horizon. Ambiguity resolution is explicit: a week that
  // hasn't been advanced must render a clear "not advanced" state and an
  // offer to advance, never a 404.
  if (!week) {
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

export type QbrView = {
  programId: string
  brief: string
  currentWeek: number
  horizonWeeks: number
  headline: string
  narrative: string
  wins: string[]
  risks: string[]
  recommendation: string
  facts: QbrFacts
  generatedAt: string
}

export type QbrResult =
  | { status: "program_not_found" }
  // Mirrors getWeekBrief's "not_advanced" ambiguity resolution: no weeks
  // completed means there is nothing to review yet, not an empty narrative.
  | { status: "no_weeks_completed"; programId: string; brief: string }
  | { status: "not_generated"; programId: string; brief: string; currentWeek: number; horizonWeeks: number }
  | { status: "ready"; data: QbrView }

/**
 * Reads the persisted QBR for a program (Task 14) — one row per program,
 * upserted by POST /api/programs/[id]/qbr rather than accumulated, per that
 * route's "persist rather than regenerate on every page load" decision.
 * `facts` is returned exactly as generated: this function never recomputes
 * cohort arithmetic, it only reads what the model was actually shown.
 */
export async function getQbrView(programId: string): Promise<QbrResult> {
  const [program] = await db.select().from(programs).where(eq(programs.id, programId)).limit(1)
  if (!program) return { status: "program_not_found" }
  if (program.currentWeek < 1) return { status: "no_weeks_completed", programId, brief: program.brief }

  const [row] = await db
    .select()
    .from(programQbrs)
    .where(eq(programQbrs.programId, programId))
    .orderBy(desc(programQbrs.generatedAt))
    .limit(1)

  if (!row) {
    return {
      status: "not_generated",
      programId,
      brief: program.brief,
      currentWeek: program.currentWeek,
      horizonWeeks: program.horizonWeeks,
    }
  }

  return {
    status: "ready",
    data: {
      programId,
      brief: program.brief,
      currentWeek: program.currentWeek,
      horizonWeeks: program.horizonWeeks,
      headline: row.headline,
      narrative: row.narrative,
      wins: row.wins as string[],
      risks: row.risks as string[],
      recommendation: row.recommendation,
      facts: row.facts as QbrFacts,
      generatedAt: row.generatedAt.toISOString(),
    },
  }
}
