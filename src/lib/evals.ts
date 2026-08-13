import { asc, desc, eq, isNotNull } from "drizzle-orm"
import type { InferSelectModel } from "drizzle-orm"
import { EVAL_BRIEFS, type EvalBrief } from "../../docs/eval-briefs"
import { HUMAN_SCENARIO_RELEVANCE_LABELS } from "../../docs/eval-human-labels"
import { db } from "@/db"
import { agentRuns, learners } from "@/db/schema"
import { BANDS, bandDistance, type Band } from "./bands"

// Read-side scoring layer for the Evals tab (Task 13). Every number this
// page shows is computed from `agent_runs` (Task 4's table — every LLM
// attempt writes a row, success AND failure) plus `learners.trueBand` (the
// seed-time, model-untouched ground truth from Task 3's bandForAccuracy).
// Never invent a number here: an empty/unmeasured input returns a zero or
// `null` that the caller must render honestly, not a fabricated result.

export type AgentRun = InferSelectModel<typeof agentRuns>

// --- Pure scoring functions -------------------------------------------------
// Unit-tested in isolation (evals.test.ts) — no DB import reachable from this
// section, so those tests never need a live Postgres connection.

/**
 * Placement accuracy against expert-consensus ground truth. Reports BOTH
 * exact-band match and within-one-band, always, at equal prominence — with
 * five bands, ±1 is a generous metric on its own, and quoting only it would
 * be exactly the flattering-number-only move the build guide warns against.
 */
export function placementAccuracy(
  rows: { predicted: Band; truth: Band }[],
): { exact: number; withinOne: number; n: number } {
  const n = rows.length
  if (n === 0) return { exact: 0, withinOne: 0, n: 0 }
  let exactCount = 0
  let withinOneCount = 0
  for (const { predicted, truth } of rows) {
    const distance = bandDistance(predicted, truth)
    if (distance === 0) exactCount++
    if (distance <= 1) withinOneCount++
  }
  return { exact: exactCount / n, withinOne: withinOneCount / n, n }
}

/**
 * Splits `agent_runs` rows into logical calls (one call = attempt 1,
 * optionally followed by attempt 2, 3, ... on the SAME logical request —
 * exactly how callWithSchema's retry loop writes them, in order, one row per
 * attempt) and reports first-try vs. eventual (post-retry) validity
 * separately. Relies on `runs` being in the same chronological order they
 * were written in (callers query ordered by createdAt, id) — attempt === 1
 * always starts a new logical call.
 */
export function schemaConformance(
  runs: AgentRun[],
): { firstTry: number; afterRetry: number; attempts: number } {
  const groups: AgentRun[][] = []
  for (const run of runs) {
    if (run.attempt === 1 || groups.length === 0) {
      groups.push([run])
    } else {
      groups[groups.length - 1].push(run)
    }
  }
  const totalCalls = groups.length
  if (totalCalls === 0) return { firstTry: 0, afterRetry: 0, attempts: 0 }
  const firstTryOk = groups.filter(g => g[0].ok).length
  const eventuallyOk = groups.filter(g => g.some(r => r.ok)).length
  return {
    firstTry: firstTryOk / totalCalls,
    afterRetry: eventuallyOk / totalCalls,
    attempts: runs.length,
  }
}

/**
 * p50 / p95 latency in ms, from `agent_runs.latency_ms`.
 *
 * Callers MUST pass only live (non-cache-hit) rows. A cache hit is served
 * from `.llm-cache/` with zero network involved — `callWithSchema` (adapter.ts)
 * hardcodes `latencyMs: 0` for that path — so a cache-hit row mixed into this
 * calculation isn't "fast," it's absent data pulling the percentile toward
 * zero. Re-running `scripts/run-evals.ts` after an earlier partial sweep is
 * exactly the case that produces this mix: briefs already fetched once serve
 * instantly from cache on the next run, briefs not yet fetched make a real,
 * slow call. Pooling the two would silently understate real latency in the
 * Evals tab and the README. This function stays a pure percentile calculator
 * over whatever rows it's given (kept simple and unit-testable, same as
 * schemaConformance) — the live/cache-hit split is loadEvalsSummary's job,
 * since only it has cacheHit on hand before calling this.
 */
export function latencyPercentiles(runs: AgentRun[]): { p50: number; p95: number } {
  const values = runs.map(r => r.latencyMs).sort((a, b) => a - b)
  if (values.length === 0) return { p50: 0, p95: 0 }
  const pick = (p: number) => values[Math.min(values.length - 1, Math.floor(p * (values.length - 1)))]
  return { p50: pick(0.5), p95: pick(0.95) }
}

// Below this sample count, a p50/p95 over live calls is too few points to
// call a percentile with a straight face — the Evals tab and the README must
// say so rather than presenting a confident-looking number over a handful of
// samples. Picked as "enough for p95 to mean something more than a single
// data point" rather than derived from any statistical test.
export const MIN_LIVE_LATENCY_SAMPLES = 5

/**
 * Fraction of paired (judge, human) scores that agree exactly. This is the
 * number the build guide insists on over the judge's self-reported score
 * alone: "the difference between running evals and performing them."
 */
export function judgeAgreement(judge: number[], human: number[]): number {
  const n = Math.min(judge.length, human.length)
  if (n === 0) return 0
  let matches = 0
  for (let i = 0; i < n; i++) {
    if (judge[i] === human[i]) matches++
  }
  return matches / n
}

// --- Cost --------------------------------------------------------------------
// `cost` is nullable and the distinction is load-bearing (see agent_runs.cost
// comment in src/db/schema.ts): `null` means "a real provider call happened on
// a model whose price we don't know," `0` means "genuinely free" (mock
// provider, or a cache hit — no call happened at all). Averaging null-as-0
// would silently understate real spend, so the mean here is computed ONLY
// over rows with a known cost, and the unknown count is reported alongside it
// so it can never be dropped silently either.
export type CostSummary = {
  knownCount: number
  unknownCount: number
  totalKnownCost: number
  meanKnownCost: number | null
}

export function costSummary(runs: AgentRun[]): CostSummary {
  const known = runs.filter((r): r is AgentRun & { cost: number } => r.cost !== null)
  const totalKnownCost = known.reduce((sum, r) => sum + r.cost, 0)
  return {
    knownCount: known.length,
    unknownCount: runs.length - known.length,
    totalKnownCost,
    meanKnownCost: known.length > 0 ? totalKnownCost / known.length : null,
  }
}

// --- DB-aware summary for the Evals page / API route -------------------------

export type AdversarialBriefOutcome = {
  label: string
  text: string
  ranSuccessfully: boolean
  note: string
}

export type FailureLogEntry = {
  id: string
  kind: string
  briefLabel: string | null
  model: string
  attempt: number
  error: string | null
  output: unknown
  createdAt: string
}

// Identifies exactly which run of scripts/run-evals.ts produced the numbers
// on the page — provider, model, how many briefs it covered, and when it
// ran, all read from the sweep's OWN agent_runs rows (never from the current
// process.env.LLM_PROVIDER, which describes the reader's environment, not
// the data). Code review fix round 2 on Task 13: this is the fix for
// "sweeps pool across providers" — the page must say what it's showing, not
// just show it.
export type SweepProvenance = {
  sweepId: string
  provider: string
  model: string
  briefCount: number
  ranAt: string
  isMock: boolean
}

// How many of the sweep's agent_runs rows were served from .llm-cache/
// (cacheHit=true — no network call, latencyMs hardcoded to 0) versus a real
// live provider call. Re-running scripts/run-evals.ts after an earlier
// partial run produces exactly this mix: already-fetched briefs replay
// instantly from cache, not-yet-fetched briefs make a real call. The page
// and the README must disclose this split — a reader can't otherwise tell
// whether "20 briefs covered" means 20 real calls or a handful of real calls
// plus a lot of free replays.
export type CallBreakdown = { total: number; live: number; cached: number }

export type EvalsSummary = {
  sweep: SweepProvenance | null
  sweepRunCount: number
  briefsCovered: number
  totalBriefs: number
  schemaConformance: ReturnType<typeof schemaConformance>
  placementAccuracy: ReturnType<typeof placementAccuracy>
  callBreakdown: CallBreakdown
  latency: ReturnType<typeof latencyPercentiles> & { liveSampleCount: number; meaningful: boolean }
  cost: CostSummary
  scenarioRelevance: {
    judgeScores: { briefLabel: string; score: number }[]
    judgeMean: number | null
    humanLabeledCount: number
    totalBriefs: number
    agreement: number | null
  }
  failureLog: FailureLogEntry[]
  incompleteBriefs: IncompleteBrief[]
  adversarial: AdversarialBriefOutcome[]
}

// A brief that has SOME rows in this sweep but never completed the full
// cohort -> placement -> curriculum chain. Exists because of a real gap
// found by Task 15's actual OpenAI sweep: brief 9 failed with a transport
// error ("fetch failed") inside the curriculum call, and — before
// adapter.ts's transport-error handling was fixed (see callWithSchema's doc
// comment) — that kind of failure skipped agent_runs entirely, so it shows
// up nowhere in `failureLog` (which only ever sees ok=false ROWS, and none
// were written). A brief with cohort+placement rows but no curriculum row
// would otherwise read as fully successful — briefsCovered/totalBriefs and
// an empty failureLog both look clean. This check is generic (any brief
// missing one of the three required kinds, for any reason, on any sweep —
// past or future) rather than hardcoded to brief 9, so it keeps catching
// this even now that new transport failures DO write a row.
export type IncompleteBrief = { label: string; presentKinds: string[]; missingKinds: string[] }

const REQUIRED_GENERATION_KINDS = ["cohort", "placement", "curriculum"] as const

function isPlacementOutputRow(v: unknown): v is { learnerId: string; band: string } {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as { learnerId?: unknown }).learnerId === "string" &&
    typeof (v as { band?: unknown }).band === "string"
  )
}

function adversarialNote(isMock: boolean, ranSuccessfully: boolean): string {
  if (isMock) {
    return (
      "Not yet meaningfully evaluated: the current provider is the deterministic mock, which returns " +
      "schema-valid placeholder text regardless of what the brief actually says — it cannot demonstrate " +
      "real pushback (or real compliance) on a bad brief. This becomes observable once the real eval " +
      "sweep runs (a live key is configured but deliberately not used for this task)."
    )
  }
  return ranSuccessfully
    ? "Generation completed without a schema failure for this brief — see the raw generated program " +
        "(cohort understanding, success criteria, curriculum) below for how the model actually responded."
    : "Generation did not complete cleanly for this brief — see the failure log for the raw output."
}

/** The all-zero/empty summary shown when no eval sweep has ever been run. */
function emptyEvalsSummary(): EvalsSummary {
  return {
    sweep: null,
    sweepRunCount: 0,
    briefsCovered: 0,
    totalBriefs: EVAL_BRIEFS.length,
    schemaConformance: schemaConformance([]),
    placementAccuracy: placementAccuracy([]),
    callBreakdown: { total: 0, live: 0, cached: 0 },
    latency: { ...latencyPercentiles([]), liveSampleCount: 0, meaningful: false },
    cost: costSummary([]),
    scenarioRelevance: {
      judgeScores: [],
      judgeMean: null,
      humanLabeledCount: 0,
      totalBriefs: EVAL_BRIEFS.length,
      agreement: null,
    },
    failureLog: [],
    incompleteBriefs: [],
    adversarial: EVAL_BRIEFS
      .filter((b: EvalBrief) => b.category === "adversarial")
      .map(b => ({
        label: b.label,
        text: b.text,
        ranSuccessfully: false,
        note: "No eval sweep has been run yet — nothing to report for this brief.",
      })),
  }
}

/**
 * Loads and scores everything the Evals tab shows — scoped to exactly ONE
 * sweep, the most recently written one, never a pool across every sweep ever
 * run. Code review fix round 2 on Task 13: `agent_runs.sweep_id` (written
 * once per scripts/run-evals.ts invocation, shared by every row that run
 * writes) is what makes "exactly one sweep" possible — without it, a later
 * sweep under a different provider would silently average its rows together
 * with an earlier sweep's (mock's included) in the same result set, and the
 * headline number would quietly become a meaningless blend. Older sweeps
 * stay in the table (useful history, and a future failure log might want
 * them) but are never included in the numbers this function returns.
 */
export async function loadEvalsSummary(): Promise<EvalsSummary> {
  const [latestSweepRow] = await db
    .select({ sweepId: agentRuns.sweepId })
    .from(agentRuns)
    .where(isNotNull(agentRuns.sweepId))
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
    .limit(1)

  if (!latestSweepRow?.sweepId) {
    return emptyEvalsSummary()
  }
  const sweepId = latestSweepRow.sweepId

  const sweepRuns = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.sweepId, sweepId))
    .orderBy(asc(agentRuns.createdAt), asc(agentRuns.id))

  if (sweepRuns.length === 0) {
    // Unreachable in practice — sweepId above came from a real row — kept as
    // a defensive fallback rather than assuming array non-emptiness.
    return emptyEvalsSummary()
  }

  // Provenance is read from the sweep's OWN rows, never from the current
  // process.env.LLM_PROVIDER — that env var describes whoever is loading
  // this page right now, not the data being shown. A reader could have any
  // provider configured locally while looking at a sweep someone else ran;
  // `isMock` has to describe the sweep, not the reader. Every row a single
  // run-evals.ts invocation writes shares one provider/model (both resolved
  // once per process, in adapter.ts), so the first row's values apply to the
  // whole sweep.
  const briefCount = new Set(sweepRuns.map(r => r.briefLabel).filter((x): x is string => x !== null)).size
  const ranAt = sweepRuns
    .reduce((min, r) => (r.createdAt < min ? r.createdAt : min), sweepRuns[0].createdAt)
    .toISOString()
  const sweep: SweepProvenance = {
    sweepId,
    provider: sweepRuns[0].provider,
    model: sweepRuns[0].model,
    briefCount,
    ranAt,
    isMock: sweepRuns[0].provider.toLowerCase() === "mock",
  }
  const isMock = sweep.isMock

  const conformance = schemaConformance(sweepRuns)

  // Live vs. cache-served split — see latencyPercentiles' doc comment and
  // CallBreakdown's for why this can't be skipped: re-running the sweep
  // script after an earlier partial run mixes free, instant cache replays
  // (briefs already fetched) with real, slow calls (briefs not yet fetched)
  // in the same sweep_id. Pooling them into one latency figure would
  // silently understate real latency.
  const liveRuns = sweepRuns.filter(r => !r.cacheHit)
  const cachedRuns = sweepRuns.filter(r => r.cacheHit)
  const callBreakdown: CallBreakdown = {
    total: sweepRuns.length,
    live: liveRuns.length,
    cached: cachedRuns.length,
  }
  const latency = {
    ...latencyPercentiles(liveRuns),
    liveSampleCount: liveRuns.length,
    meaningful: liveRuns.length >= MIN_LIVE_LATENCY_SAMPLES,
  }
  const cost = costSummary(sweepRuns)

  // Placement accuracy: every learnerId cited in a successful placement-kind
  // run, matched against learners.trueBand — the seed-time, model-untouched
  // ground truth. Pooled across the whole sweep (every brief re-places the
  // same seeded cohort), which is why n can run well past the cohort size.
  const learnerRows = await db.select({ id: learners.id, trueBand: learners.trueBand }).from(learners)
  const truthByLearner = new Map(learnerRows.map(l => [l.id, l.trueBand as Band]))
  const placementPairs: { predicted: Band; truth: Band }[] = []
  for (const run of sweepRuns) {
    if (run.kind !== "placement" || !run.ok || !Array.isArray(run.output)) continue
    for (const row of run.output) {
      if (!isPlacementOutputRow(row)) continue
      const truth = truthByLearner.get(row.learnerId)
      if (truth && (BANDS as readonly string[]).includes(row.band)) {
        placementPairs.push({ predicted: row.band as Band, truth })
      }
    }
  }
  const placement = placementAccuracy(placementPairs)

  // Scenario relevance judge: one score per brief (last ok=true judge row
  // wins, since sweepRuns is ordered ascending — a retried judge call's final
  // valid attempt is the one that counts).
  const judgeByBrief = new Map<string, number>()
  for (const run of sweepRuns) {
    if (run.kind !== "judge" || !run.ok || !run.briefLabel) continue
    const out = run.output as { score?: unknown } | null
    if (out && typeof out.score === "number") judgeByBrief.set(run.briefLabel, out.score)
  }
  const judgeScores = [...judgeByBrief.entries()]
    .map(([briefLabel, score]) => ({ briefLabel, score }))
    .sort((a, b) => Number(a.briefLabel) - Number(b.briefLabel))
  const judgeMean = judgeScores.length > 0
    ? judgeScores.reduce((sum, s) => sum + s.score, 0) / judgeScores.length
    : null

  const pairedJudge: number[] = []
  const pairedHuman: number[] = []
  for (const { briefLabel, score } of judgeScores) {
    const human = HUMAN_SCENARIO_RELEVANCE_LABELS[briefLabel]
    if (human !== null && human !== undefined) {
      pairedJudge.push(score)
      pairedHuman.push(human)
    }
  }
  const humanLabeledCount = pairedHuman.length
  const agreement = humanLabeledCount > 0 ? judgeAgreement(pairedJudge, pairedHuman) : null

  const failureLog: FailureLogEntry[] = sweepRuns
    .filter(r => !r.ok)
    .map(r => ({
      id: r.id,
      kind: r.kind,
      briefLabel: r.briefLabel,
      model: r.model,
      attempt: r.attempt,
      error: r.error,
      output: r.output,
      createdAt: r.createdAt.toISOString(),
    }))

  const adversarial: AdversarialBriefOutcome[] = EVAL_BRIEFS
    .filter((b: EvalBrief) => b.category === "adversarial")
    .map(b => {
      const rows = sweepRuns.filter(r => r.briefLabel === b.label)
      const ranSuccessfully = ["cohort", "placement", "curriculum"].every(kind =>
        rows.some(r => r.kind === kind && r.ok),
      )
      return { label: b.label, text: b.text, ranSuccessfully, note: adversarialNote(isMock, ranSuccessfully) }
    })

  // See IncompleteBrief's doc comment: a brief with SOME rows but missing one
  // of the three required generation kinds never shows up in `failureLog`
  // (empty if the missing step failed via a transport error, on a sweep run
  // before adapter.ts logged those) or as an obvious gap in briefsCovered —
  // this is the check that surfaces it anyway, generically, not just for the
  // specific brief that happened to trigger it.
  const briefLabelsInSweep = [...new Set(sweepRuns.map(r => r.briefLabel).filter((x): x is string => x !== null))]
  const incompleteBriefs: IncompleteBrief[] = briefLabelsInSweep
    .map(label => {
      const kindsPresent = new Set(sweepRuns.filter(r => r.briefLabel === label && r.ok).map(r => r.kind))
      const presentKinds = REQUIRED_GENERATION_KINDS.filter(k => kindsPresent.has(k))
      const missingKinds = REQUIRED_GENERATION_KINDS.filter(k => !kindsPresent.has(k))
      return { label, presentKinds, missingKinds }
    })
    .filter(b => b.missingKinds.length > 0)
    .sort((a, b) => Number(a.label) - Number(b.label))

  return {
    sweep,
    sweepRunCount: sweepRuns.length,
    briefsCovered: briefCount,
    totalBriefs: EVAL_BRIEFS.length,
    schemaConformance: conformance,
    placementAccuracy: placement,
    callBreakdown,
    latency,
    cost,
    scenarioRelevance: {
      judgeScores,
      judgeMean,
      humanLabeledCount,
      totalBriefs: EVAL_BRIEFS.length,
      agreement,
    },
    failureLog,
    incompleteBriefs,
    adversarial,
  }
}
