import { asc, isNotNull } from "drizzle-orm"
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

/** p50 / p95 latency in ms, from `agent_runs.latency_ms`. */
export function latencyPercentiles(runs: AgentRun[]): { p50: number; p95: number } {
  const values = runs.map(r => r.latencyMs).sort((a, b) => a - b)
  if (values.length === 0) return { p50: 0, p95: 0 }
  const pick = (p: number) => values[Math.min(values.length - 1, Math.floor(p * (values.length - 1)))]
  return { p50: pick(0.5), p95: pick(0.95) }
}

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

export type EvalsSummary = {
  provider: string
  isMock: boolean
  sweepRunCount: number
  briefsCovered: number
  totalBriefs: number
  schemaConformance: ReturnType<typeof schemaConformance>
  placementAccuracy: ReturnType<typeof placementAccuracy>
  latency: ReturnType<typeof latencyPercentiles>
  cost: CostSummary
  scenarioRelevance: {
    judgeScores: { briefLabel: string; score: number }[]
    judgeMean: number | null
    humanLabeledCount: number
    totalBriefs: number
    agreement: number | null
  }
  failureLog: FailureLogEntry[]
  adversarial: AdversarialBriefOutcome[]
}

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

/**
 * Loads and scores everything the Evals tab shows. Scoped to `agent_runs`
 * rows carrying a `brief_label` — i.e. rows scripts/run-evals.ts wrote — so
 * ordinary live-demo activity (someone typing a brief into the home page)
 * never gets silently folded into the reported eval numbers.
 */
export async function loadEvalsSummary(): Promise<EvalsSummary> {
  const provider = (process.env.LLM_PROVIDER ?? "mock").toLowerCase()
  const isMock = provider === "mock"

  const sweepRuns = await db
    .select()
    .from(agentRuns)
    .where(isNotNull(agentRuns.briefLabel))
    .orderBy(asc(agentRuns.createdAt), asc(agentRuns.id))

  const conformance = schemaConformance(sweepRuns)
  const latency = latencyPercentiles(sweepRuns)
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

  return {
    provider,
    isMock,
    sweepRunCount: sweepRuns.length,
    briefsCovered: new Set(sweepRuns.map(r => r.briefLabel).filter((x): x is string => x !== null)).size,
    totalBriefs: EVAL_BRIEFS.length,
    schemaConformance: conformance,
    placementAccuracy: placement,
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
    adversarial,
  }
}
