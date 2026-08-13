import { inArray } from "drizzle-orm"
import { describe, it, expect } from "vitest"
import { placementAccuracy, schemaConformance, latencyPercentiles, judgeAgreement } from "./evals"

describe("placementAccuracy — reports BOTH metrics, never just the flattering one", () => {
  it("computes exact and within-one separately", () => {
    const r = placementAccuracy([
      { predicted: "B1", truth: "B1" },   // exact
      { predicted: "B2", truth: "B1" },   // within one
      { predicted: "C1", truth: "A1" },   // neither
      { predicted: "A2", truth: "A2" },   // exact
    ])
    expect(r.n).toBe(4)
    expect(r.exact).toBeCloseTo(0.5)
    expect(r.withinOne).toBeCloseTo(0.75)
  })
  it("returns zeroes rather than NaN for an empty set", () => {
    expect(placementAccuracy([])).toEqual({ exact: 0, withinOne: 0, n: 0 })
  })
})

describe("schemaConformance", () => {
  it("separates first-try success from post-retry success", () => {
    const runs = [
      { ok: true,  attempt: 1 }, { ok: false, attempt: 1 }, { ok: true, attempt: 2 },
      { ok: false, attempt: 1 }, { ok: false, attempt: 2 },
    ] as any
    const c = schemaConformance(runs)
    expect(c.firstTry).toBeCloseTo(1 / 3)     // 1 of 3 logical calls valid first try
    expect(c.afterRetry).toBeCloseTo(2 / 3)   // 2 of 3 valid eventually
  })
})

describe("latencyPercentiles", () => {
  it("computes p50 and p95", () => {
    const runs = Array.from({ length: 100 }, (_, i) => ({ latencyMs: i + 1 })) as any
    const p = latencyPercentiles(runs)
    expect(p.p50).toBeGreaterThanOrEqual(50)
    expect(p.p95).toBeGreaterThanOrEqual(95)
  })
  // This function itself takes whatever rows it's handed (stays a simple,
  // pure percentile calculator) — the guarantee that cache hits never enter
  // it lives in loadEvalsSummary's own filtering, tested below against a
  // real sweep in the DB, not here. This test just pins the documented
  // contract: a cache-hit row's hardcoded latencyMs=0 (see adapter.ts) drags
  // the percentile toward zero if it's ever mixed in — proving why the split
  // matters, not asserting the split itself.
  it("a single cache-hit row (latencyMs=0) mixed with real latencies pulls the percentile down", () => {
    const allRuns = [
      { latencyMs: 0 },   // cache hit
      { latencyMs: 50000 }, { latencyMs: 60000 }, { latencyMs: 70000 },
    ] as any
    const liveOnly = allRuns.slice(1)
    expect(latencyPercentiles(allRuns).p50).toBeLessThan(latencyPercentiles(liveOnly).p50)
  })
})

describe("judgeAgreement", () => {
  it("is 1 when the judge and the human agree exactly", () => {
    expect(judgeAgreement([3, 2, 1], [3, 2, 1])).toBe(1)
  })
  it("is 0 when they never agree", () => {
    expect(judgeAgreement([3, 3, 3], [0, 0, 0])).toBe(0)
  })
})

// Code review fix round 2 on Task 13, CRITICAL finding: loadEvalsSummary used
// to filter only on `brief_label IS NOT NULL`, so a later eval sweep (Task
// 15, real provider) would silently get pooled together with every earlier
// sweep (including this one, mock) in the same averages the moment both
// existed in agent_runs — the exact failure the evals page exists to
// prevent. This is the persisted guard: two sweeps, two different providers,
// directly in agent_runs (bypassing scripts/run-evals.ts entirely, the same
// way the reviewer independently re-derived the numbers from Postgres), and
// asserts loadEvalsSummary reports ONLY the newer sweep's data and names it.
describe("loadEvalsSummary — sweep isolation (regression, code review fix round 2)", () => {
  it("scopes every metric to the most recently written sweep_id, and reports that sweep's own provenance", async () => {
    const { db } = await import("@/db")
    const { agentRuns, learners } = await import("@/db/schema")
    const { BANDS } = await import("./bands")
    const { loadEvalsSummary } = await import("./evals")
    const { randomUUID } = await import("crypto")

    const [learner] = await db
      .select({ id: learners.id, trueBand: learners.trueBand })
      .from(learners)
      .limit(1)
    expect(learner).toBeTruthy()

    // A band at least two steps from the truth — bandDistance is a plain
    // index difference (BANDS is NOT circular), so (trueIndex + 2) % 5 is
    // guaranteed >= 2 away for every possible trueIndex in a 5-band table.
    // Neither "exact" nor "within one" for the newer sweep's placement.
    const trueIndex = BANDS.indexOf(learner.trueBand as (typeof BANDS)[number])
    const farBand = BANDS[(trueIndex + 2) % BANDS.length]

    const oldSweepId = `test-old-sweep-${randomUUID()}`
    const newSweepId = `test-new-sweep-${randomUUID()}`

    const baseRow = {
      input: {},
      ok: true as const,
      attempt: 1,
      error: null,
      cacheHit: false,
      latencyMs: 10,
      cost: 0,
    }

    try {
      // Older sweep: mock provider, placement is an EXACT match (distance 0)
      // — if this leaked into the result, placementAccuracy.exact would be
      // nonzero and n would be 2, not 1.
      await db.insert(agentRuns).values({
        ...baseRow,
        id: randomUUID(),
        kind: "placement",
        provider: "mock",
        model: "mock-model",
        briefLabel: "test-brief-old",
        sweepId: oldSweepId,
        output: [{ learnerId: learner.id, band: learner.trueBand, rationale: "old", evidenceUtteranceIds: ["x"] }],
        createdAt: new Date(Date.now() - 60_000),
      })

      // Newer sweep: a DIFFERENT provider, placement is far off (distance >= 2).
      await db.insert(agentRuns).values({
        ...baseRow,
        id: randomUUID(),
        kind: "placement",
        provider: "test-provider-openai",
        model: "test-model-gpt",
        briefLabel: "test-brief-new",
        sweepId: newSweepId,
        output: [{ learnerId: learner.id, band: farBand, rationale: "new", evidenceUtteranceIds: ["x"] }],
        createdAt: new Date(),
      })

      const summary = await loadEvalsSummary()

      // Provenance names the NEWER sweep, not the older one, and not the
      // reader's own LLM_PROVIDER env var (which is "mock" in this test run
      // — the sweep's recorded provider is "test-provider-openai").
      expect(summary.sweep).not.toBeNull()
      expect(summary.sweep?.sweepId).toBe(newSweepId)
      expect(summary.sweep?.provider).toBe("test-provider-openai")
      expect(summary.sweep?.model).toBe("test-model-gpt")
      expect(summary.sweep?.isMock).toBe(false)

      // Metrics reflect ONLY the newer sweep's one placement — not pooled
      // with the older sweep's exact-match row.
      expect(summary.placementAccuracy.n).toBe(1)
      expect(summary.placementAccuracy.exact).toBe(0)
      expect(summary.placementAccuracy.withinOne).toBe(0)
    } finally {
      await db.delete(agentRuns).where(inArray(agentRuns.sweepId, [oldSweepId, newSweepId]))
    }
  })
})

// Real-world trigger for this one: scripts/run-evals.ts got interrupted
// partway through a sweep (Task 15's actual OpenAI run), and re-running it
// resumed under a NEW sweepId — but briefs already fetched the first time
// replayed instantly from .llm-cache/ (cacheHit=true, latencyMs=0 by
// construction, see adapter.ts), while not-yet-fetched briefs made real,
// slow calls in the same sweep_id. Pooling both into one p50/p95 would
// silently understate real latency in the Evals tab and the README.
describe("loadEvalsSummary — latency excludes cache hits (regression)", () => {
  it("computes p50/p95 only over cacheHit=false rows and reports the live/cached split", async () => {
    const { db } = await import("@/db")
    const { agentRuns } = await import("@/db/schema")
    const { loadEvalsSummary } = await import("./evals")
    const { randomUUID } = await import("crypto")

    const sweepId = `test-latency-sweep-${randomUUID()}`
    const baseRow = {
      input: {}, output: null, ok: true as const, attempt: 1, error: null,
      provider: "test-provider-openai", model: "test-model-gpt",
      briefLabel: "test-brief", sweepId, createdAt: new Date(),
    }

    try {
      // One cache hit (latency 0, cost 0 — genuinely free, not "fast") plus
      // three real live calls with known, distinct latencies.
      await db.insert(agentRuns).values([
        { ...baseRow, id: randomUUID(), kind: "cohort", cacheHit: true, latencyMs: 0, cost: 0 },
        { ...baseRow, id: randomUUID(), kind: "placement", cacheHit: false, latencyMs: 50000, cost: null },
        { ...baseRow, id: randomUUID(), kind: "curriculum", cacheHit: false, latencyMs: 60000, cost: null },
        { ...baseRow, id: randomUUID(), kind: "judge", cacheHit: false, latencyMs: 70000, cost: null },
      ])

      const summary = await loadEvalsSummary()
      expect(summary.sweep?.sweepId).toBe(sweepId)

      // Live/cached split is reported...
      expect(summary.callBreakdown).toEqual({ total: 4, live: 3, cached: 1 })

      // ...and the cache hit's latencyMs=0 never enters the percentile: p50
      // over the three live calls (50000/60000/70000) is 60000, not pulled
      // toward 0 by the fourth, cached row.
      expect(summary.latency.liveSampleCount).toBe(3)
      expect(summary.latency.p50).toBe(60000)
      expect(summary.latency.meaningful).toBe(false) // 3 < MIN_LIVE_LATENCY_SAMPLES (5)
    } finally {
      await db.delete(agentRuns).where(inArray(agentRuns.sweepId, [sweepId]))
    }
  })
})

// Real-world trigger: brief 9 of the actual Task 15 OpenAI sweep had a
// cohort row and a placement row, both ok=true, but its curriculum call
// failed with a transport error that (on that sweep, which predates
// adapter.ts logging transport errors) left NO row at all — so the brief
// looked, from failureLog and briefsCovered alone, indistinguishable from a
// brief that completed cleanly.
describe("loadEvalsSummary — incompleteBriefs (regression)", () => {
  it("flags a brief that has cohort+placement rows but no curriculum row, even though failureLog is empty", async () => {
    const { db } = await import("@/db")
    const { agentRuns } = await import("@/db/schema")
    const { loadEvalsSummary } = await import("./evals")
    const { randomUUID } = await import("crypto")

    const sweepId = `test-incomplete-sweep-${randomUUID()}`
    const baseRow = {
      input: {}, output: null, ok: true as const, attempt: 1, error: null,
      provider: "test-provider-openai", model: "test-model-gpt",
      sweepId, cacheHit: false, latencyMs: 1000, cost: null, createdAt: new Date(),
    }

    try {
      await db.insert(agentRuns).values([
        { ...baseRow, id: randomUUID(), kind: "cohort", briefLabel: "9" },
        { ...baseRow, id: randomUUID(), kind: "placement", briefLabel: "9" },
        // No "curriculum" row for brief 9 — the transport error skipped it.
        // A fully complete brief for comparison, so the check isn't trivially
        // true for every brief in the sweep:
        { ...baseRow, id: randomUUID(), kind: "cohort", briefLabel: "1" },
        { ...baseRow, id: randomUUID(), kind: "placement", briefLabel: "1" },
        { ...baseRow, id: randomUUID(), kind: "curriculum", briefLabel: "1" },
      ])

      const summary = await loadEvalsSummary()
      expect(summary.sweep?.sweepId).toBe(sweepId)
      expect(summary.failureLog).toEqual([])   // the gap: nothing here flags brief 9
      expect(summary.incompleteBriefs).toEqual([
        { label: "9", presentKinds: ["cohort", "placement"], missingKinds: ["curriculum"] },
      ])
    } finally {
      await db.delete(agentRuns).where(inArray(agentRuns.sweepId, [sweepId]))
    }
  })
})
