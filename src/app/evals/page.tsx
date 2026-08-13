import Link from "next/link"
import { BAND_TABLE } from "@/lib/bands"
import { loadEvalsSummary, type SweepProvenance } from "@/lib/evals"

export const dynamic = "force-dynamic"

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

function fmtMs(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`
}

function fmtCost(n: number): string {
  return `$${n.toFixed(4)}`
}

function fmtRanAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

export default async function EvalsPage() {
  const s = await loadEvalsSummary()
  const sweep = s.sweep

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10">
      <div className="mb-8 flex flex-col gap-3 border-b border-[var(--line)] pb-6">
        <div className="flex items-center justify-between gap-4">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">Evals</p>
          <Link
            href="/"
            className="font-mono text-[11px] uppercase tracking-wide text-[var(--ink-faint)] transition-colors hover:text-[var(--accent)]"
          >
            ← Home
          </Link>
        </div>
        <h1 className="font-display text-2xl leading-snug text-[var(--ink)]">
          What the system actually does, measured against real expert scores.
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-[var(--ink-soft)]">
          Every number on this page is a query over <code className="font-mono text-[12px]">agent_runs</code> —
          the table every LLM attempt writes to, successes and failures alike — scoped to a single eval sweep
          (<code className="font-mono text-[12px]">sweep_id</code>), the most recent one run by{" "}
          <code className="font-mono text-[12px]">scripts/run-evals.ts</code> against the{" "}
          {s.totalBriefs} briefs in <code className="font-mono text-[12px]">docs/eval-briefs.ts</code> (Appendix
          B). Older sweeps stay in the table as history but are never averaged into these numbers.
        </p>
      </div>

      <ProvenanceBanner sweep={sweep} />

      <div className="mt-8 flex flex-col gap-8">
        <SweepStatus s={s} />

        {sweep === null ? (
          <div className="rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-raised)] p-6 text-sm text-[var(--ink-faint)]">
            No eval sweep has been run yet — nothing in <code className="font-mono text-[12px]">agent_runs</code>{" "}
            carries a <code className="font-mono text-[12px]">sweep_id</code>. Run{" "}
            <code className="font-mono text-[12px]">npm run evals</code> to populate this page. Nothing below is
            rendered as a zero in the meantime — there is simply nothing to show yet.
          </div>
        ) : (
          <>
            <SchemaConformanceSection s={s} />
            <PlacementAccuracySection s={s} />
            <BandTableSection />
            <LatencyCostSection s={s} />
            <ScenarioRelevanceSection s={s} />
            <AdversarialSection s={s} />
            <FailureLogSection s={s} />
            <IncompleteBriefsSection s={s} />
          </>
        )}
      </div>
    </main>
  )
}

// Code review fix round 2 on Task 13: states the provenance of the sweep
// being shown — provider, model, brief count, when it ran — read from the
// sweep's OWN agent_runs rows, never from the reader's current LLM_PROVIDER
// env var (a viewer can have any provider configured locally while looking
// at a sweep someone else ran; the badge has to describe the DATA, not the
// reader). Sits directly under the headline, not a footnote, and is the
// single source both the "not yet measured" banner and every per-card
// MockBadge below key off.
function ProvenanceBanner({ sweep }: { sweep: SweepProvenance | null }) {
  if (!sweep) {
    return (
      <div className="flex flex-col gap-2 rounded-xl border-2 border-dashed border-[var(--ink-faint)] bg-[var(--paper-raised)] p-5">
        <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--ink-faint)]">
          No eval sweep on record
        </p>
        <p className="text-sm leading-relaxed text-[var(--ink-soft)]">
          Nothing below is measured, mock-derived, or otherwise — there is no sweep to report on yet.
        </p>
      </div>
    )
  }

  const provenanceLine = (
    <p className="font-mono text-[11px] leading-relaxed">
      provider <strong className="font-semibold">{sweep.provider}</strong> · model{" "}
      <strong className="font-semibold">{sweep.model}</strong> · {sweep.briefCount} briefs · ran{" "}
      {fmtRanAt(sweep.ranAt)} · <span className="opacity-70">sweep {sweep.sweepId.slice(0, 8)}</span>
    </p>
  )

  if (!sweep.isMock) {
    return (
      <div
        data-sweep-banner=""
        data-sweep-mock="false"
        className="flex flex-col gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--paper-raised)] p-4"
      >
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">Measured sweep</p>
        {provenanceLine}
        <p className="text-sm leading-relaxed text-[var(--ink-soft)]">
          The numbers below are a real, measured eval sweep against this provider — not fixture output.
        </p>
      </div>
    )
  }

  return (
    <div
      data-sweep-banner=""
      data-sweep-mock="true"
      className="flex flex-col gap-2 rounded-xl border-2 border-dashed border-[var(--accent)] bg-[var(--accent-soft)] p-5"
    >
      <div className="flex items-center gap-2">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 1L15 14H1L8 1Z"
            stroke="var(--accent)"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <path d="M8 6V9.5" stroke="var(--accent)" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="8" cy="11.8" r="0.9" fill="var(--accent)" />
        </svg>
        <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
          Not yet measured — this sweep used the mock provider
        </p>
      </div>
      {provenanceLine}
      <p className="text-sm leading-relaxed text-[var(--ink)]">
        Every number below comes from the deterministic mock provider — fixture output that always validates
        and always costs $0 — not from a real model. It measures the harness (does the retry loop work, does
        every attempt land in <code className="font-mono text-[12px]">agent_runs</code>, does the page render
        honestly) and nothing about real model quality. A live API key is configured but deliberately unused
        here; the real eval sweep is a separate, later step, run once and reported as such.
      </p>
    </div>
  )
}

function SweepStatus({ s }: { s: Awaited<ReturnType<typeof loadEvalsSummary>> }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 font-mono text-[11px] text-[var(--ink-faint)]">
      <span>
        {s.sweepRunCount} agent_runs row{s.sweepRunCount === 1 ? "" : "s"} tagged with a brief_label
      </span>
      <span>
        {s.briefsCovered} / {s.totalBriefs} briefs covered
      </span>
    </div>
  )
}

// Code review fix round 1 on Task 13, Finding 1 (Critical): the single mock
// banner near the top of the page scrolls fully off-screen by the time a
// reader reaches the numbers it disclaims — a cropped screenshot of any one
// metric card (exactly the kind of screenshot the build guide's "legible to
// a non-technical stakeholder" headline number invites) would be
// indistinguishable from a real measurement. This badge repeats that
// disclosure locally, on every headline number, so the caveat survives
// partial reading and cropping, not just a full top-to-bottom read. Driven
// by the same `isMock` (== `LLM_PROVIDER === "mock"`) the banner uses, so it
// disappears on its own once Task 15's real sweep changes the provider — the
// real numbers then stand unqualified, nothing hardcoded to remove later.
function MockBadge() {
  return (
    <span
      data-mock-badge=""
      title="This figure comes from the deterministic mock provider, not a measured model — see the banner above."
      className="inline-flex w-fit items-center gap-1 rounded-full border border-dashed border-[var(--accent)] bg-[var(--accent-soft)] px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase leading-none tracking-wide text-[var(--accent)]"
    >
      mock · not measured
    </span>
  )
}

function MetricCard({
  eyebrow, value, caption, wide, isMock,
}: {
  eyebrow: string
  value: string
  caption?: string
  wide?: boolean
  isMock: boolean
}) {
  return (
    <div
      className={`flex flex-col gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--paper-raised)] p-5 ${wide ? "sm:col-span-2" : ""}`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--ink-faint)]">{eyebrow}</p>
        {isMock && <MockBadge />}
      </div>
      <p className="font-mono text-3xl font-medium text-[var(--ink)]">{value}</p>
      {caption && <p className="text-[12px] leading-relaxed text-[var(--ink-soft)]">{caption}</p>}
    </div>
  )
}

function SectionEyebrow({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ink-faint)]">{children}</p>
}

function SchemaConformanceSection({ s }: { s: Awaited<ReturnType<typeof loadEvalsSummary>> }) {
  const c = s.schemaConformance
  return (
    <section className="flex flex-col gap-3">
      <SectionEyebrow>Schema conformance</SectionEyebrow>
      <div className="grid gap-3 sm:grid-cols-2">
        <MetricCard
          eyebrow="Valid on first try"
          value={pct(c.firstTry)}
          caption="Fraction of logical calls whose attempt-1 output already matched the schema."
          isMock={s.sweep?.isMock ?? true}
        />
        <MetricCard
          eyebrow="Valid after retry"
          value={pct(c.afterRetry)}
          caption="Fraction of logical calls that eventually validated, first try or one retry."
          isMock={s.sweep?.isMock ?? true}
        />
      </div>
      <p className="font-mono text-[11px] text-[var(--ink-faint)]">{c.attempts} total attempts logged.</p>
    </section>
  )
}

function PlacementAccuracySection({ s }: { s: Awaited<ReturnType<typeof loadEvalsSummary>> }) {
  const p = s.placementAccuracy
  return (
    <section className="flex flex-col gap-3">
      <SectionEyebrow>Placement accuracy vs. expert consensus</SectionEyebrow>
      <p className="text-[12px] leading-relaxed text-[var(--ink-soft)]">
        Ground truth is <code className="font-mono text-[12px]">learners.trueBand</code>, computed once at
        seed time from the five-expert mean accuracy — untouched by any model. Exact-band match and
        within-one-band are reported at equal weight: with five bands, ±1 is a generous metric on its own.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <MetricCard eyebrow="Exact band match" value={p.n > 0 ? pct(p.exact) : "—"} isMock={s.sweep?.isMock ?? true} />
        <MetricCard eyebrow="Within one band" value={p.n > 0 ? pct(p.withinOne) : "—"} isMock={s.sweep?.isMock ?? true} />
      </div>
      <p className="font-mono text-[11px] text-[var(--ink-faint)]">
        {p.n > 0
          ? `n = ${p.n} placements, pooled across every brief in the sweep.`
          : "n = 0 — no successful placement runs in agent_runs yet."}
      </p>
    </section>
  )
}

function BandTableSection() {
  return (
    <section className="flex flex-col gap-3">
      <SectionEyebrow>Band table (fixed, published before any eval ran)</SectionEyebrow>
      <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--paper-raised)]">
        <table className="w-full min-w-[420px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--line)]">
              <th className="px-4 py-2 font-mono text-[11px] uppercase tracking-wide text-[var(--ink-faint)]">
                Band
              </th>
              <th className="px-4 py-2 font-mono text-[11px] uppercase tracking-wide text-[var(--ink-faint)]">
                Mean expert accuracy
              </th>
            </tr>
          </thead>
          <tbody>
            {BAND_TABLE.map(row => (
              <tr key={row.band} className="border-b border-[var(--line)] last:border-b-0">
                <td className="px-4 py-2 font-mono text-[13px] font-medium text-[var(--ink)]">{row.band}</td>
                <td className="px-4 py-2 font-mono text-[13px] text-[var(--ink-soft)]">
                  {row.min === -Infinity ? "below " : ""}
                  {row.min === -Infinity ? row.max.toFixed(1) : row.min.toFixed(1)}
                  {row.max === Infinity ? " and up" : row.min === -Infinity ? "" : ` – ${row.max.toFixed(1)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[12px] leading-relaxed text-[var(--ink-faint)]">
        This table is never tuned to improve a result — src/lib/bands.ts is the single source of truth and it
        was fixed before this sweep ran. These bands are pronunciation-derived proxies computed from
        speechocean762 expert accuracy scores, <strong className="text-[var(--ink-soft)]">not CEFR proficiency
        assessments</strong>.
      </p>
    </section>
  )
}

function LatencyCostSection({ s }: { s: Awaited<ReturnType<typeof loadEvalsSummary>> }) {
  const { latency, cost, callBreakdown } = s
  return (
    <section className="flex flex-col gap-3">
      <SectionEyebrow>Latency &amp; cost</SectionEyebrow>
      <p className="text-[12px] leading-relaxed text-[var(--ink-soft)]">
        <strong className="text-[var(--ink)]">{callBreakdown.live}</strong> of{" "}
        <strong className="text-[var(--ink)]">{callBreakdown.total}</strong> calls in this sweep were live
        (real network calls); <strong className="text-[var(--ink)]">{callBreakdown.cached}</strong> were served
        from <code className="font-mono text-[12px]">.llm-cache/</code> (a prompt this sweep — or an earlier,
        interrupted one under the same corpus — already fetched for real). A cache hit is genuinely
        instantaneous and free, not fast: mixing it into a latency percentile would silently understate real
        latency, so the figures below are computed <strong className="text-[var(--ink)]">only over the
        {" "}{latency.liveSampleCount} live call{latency.liveSampleCount === 1 ? "" : "s"}</strong>, never pooled
        with cache hits.
      </p>
      {!latency.meaningful && (
        <div className="rounded-xl border border-dashed border-[var(--accent)] bg-[var(--accent-soft)] p-4 text-[12px] leading-relaxed text-[var(--ink)]">
          Only {latency.liveSampleCount} live call{latency.liveSampleCount === 1 ? "" : "s"} in this sweep —
          too few to report a p50/p95 percentile with a straight face. The numbers below are shown for
          completeness but should be read as individual samples, not a stable percentile.
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <MetricCard
          eyebrow="p50 latency"
          value={latency.liveSampleCount > 0 ? fmtMs(latency.p50) : "—"}
          caption={`over ${latency.liveSampleCount} live call${latency.liveSampleCount === 1 ? "" : "s"}, cache hits excluded`}
          isMock={s.sweep?.isMock ?? true}
        />
        <MetricCard
          eyebrow="p95 latency"
          value={latency.liveSampleCount > 0 ? fmtMs(latency.p95) : "—"}
          caption={`over ${latency.liveSampleCount} live call${latency.liveSampleCount === 1 ? "" : "s"}, cache hits excluded`}
          isMock={s.sweep?.isMock ?? true}
        />
        <MetricCard
          eyebrow="Mean cost, priced calls"
          value={cost.meanKnownCost === null ? "cost unknown" : fmtCost(cost.meanKnownCost)}
          caption={`${cost.knownCount} call${cost.knownCount === 1 ? "" : "s"} with a known cost (0 = genuinely free — mock or a cache hit; never fabricated).`}
          isMock={s.sweep?.isMock ?? true}
        />
        <MetricCard
          eyebrow="Unpriced calls"
          value={cost.unknownCount > 0 ? String(cost.unknownCount) : "0"}
          caption={
            cost.unknownCount > 0
              ? "A real call happened on a model whose price isn't configured — reported as unknown, never as $0.00."
              : "Every logged call had a known cost."
          }
          isMock={s.sweep?.isMock ?? true}
        />
      </div>
    </section>
  )
}

function ScenarioRelevanceSection({ s }: { s: Awaited<ReturnType<typeof loadEvalsSummary>> }) {
  const r = s.scenarioRelevance
  return (
    <section className="flex flex-col gap-3">
      <SectionEyebrow>Scenario relevance — judge vs. human</SectionEyebrow>
      <p className="text-[12px] leading-relaxed text-[var(--ink-soft)]">
        An LLM judge scores one scenario per brief, 0–3, against the Appendix A rubric. The judge&apos;s own
        score is not the headline metric — <strong className="text-[var(--ink)]">agreement with a human
        label on the same scenarios</strong> is, per the build guide: that is the difference between running
        evals and performing them.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <MetricCard
          eyebrow="Judge mean score"
          value={r.judgeMean === null ? "—" : `${r.judgeMean.toFixed(1)} / 3`}
          caption={`${r.judgeScores.length} of ${r.totalBriefs} briefs judged.`}
          isMock={s.sweep?.isMock ?? true}
        />
        <MetricCard
          eyebrow="Judge / human agreement"
          value={r.agreement === null ? "not available" : pct(r.agreement)}
          caption={`${r.humanLabeledCount} of ${r.totalBriefs} briefs have a human label.`}
          isMock={s.sweep?.isMock ?? true}
        />
      </div>
      {r.agreement === null && (
        <div className="rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-raised)] p-4 text-[13px] leading-relaxed text-[var(--ink-soft)]">
          No human labels exist yet for these scenarios —{" "}
          <code className="font-mono text-[12px]">docs/eval-human-labels.ts</code> is committed with every
          value honestly set to <code className="font-mono text-[12px]">null</code>. Under the mock provider,
          generated scenario text is a deterministic placeholder string, not real content — labeling it for
          job relevance would produce a number that looks like a human judgment without being one. This gets
          filled in by hand once Task 15&apos;s real provider sweep produces real scenarios to read.
        </div>
      )}
    </section>
  )
}

function AdversarialSection({ s }: { s: Awaited<ReturnType<typeof loadEvalsSummary>> }) {
  return (
    <section className="flex flex-col gap-3">
      <SectionEyebrow>Adversarial briefs (16–20)</SectionEyebrow>
      <p className="text-[12px] leading-relaxed text-[var(--ink-soft)]">
        How the system handles a bad brief is more revealing than how it handles a good one. Reported here
        exactly as it happened, not summarized to look better.
      </p>
      <div className="flex flex-col gap-2">
        {s.adversarial.map(a => (
          <div
            key={a.label}
            className="flex flex-col gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--paper-raised)] p-4"
          >
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 font-mono text-[10px] font-medium text-[var(--accent)]">
                brief {a.label}
              </span>
              <span
                className={`font-mono text-[10px] uppercase tracking-wide ${a.ranSuccessfully ? "text-[var(--ink-faint)]" : "text-[var(--band-c1)]"}`}
              >
                {a.ranSuccessfully ? "ran cleanly" : "did not complete cleanly"}
              </span>
            </div>
            <p className="font-display text-[15px] italic leading-snug text-[var(--ink)]">
              &ldquo;{a.text}&rdquo;
            </p>
            <p className="text-[13px] leading-relaxed text-[var(--ink-soft)]">{a.note}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function FailureLogSection({ s }: { s: Awaited<ReturnType<typeof loadEvalsSummary>> }) {
  return (
    <section className="flex flex-col gap-3">
      <SectionEyebrow>Failure log · {s.failureLog.length} schema violation{s.failureLog.length === 1 ? "" : "s"}</SectionEyebrow>
      {s.failureLog.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-raised)] p-4 text-sm text-[var(--ink-faint)]">
          No schema violations logged in this sweep.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {s.failureLog.map(f => (
            <details
              key={f.id}
              className="group rounded-xl border border-[var(--line)] bg-[var(--paper-raised)] p-4 open:border-[var(--accent)]"
            >
              <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--ink-soft)]">
                <span className="font-medium text-[var(--ink)]">{f.kind}</span>
                <span>brief {f.briefLabel ?? "—"}</span>
                <span>attempt {f.attempt}</span>
                <span>{f.model}</span>
                <span className="text-[var(--ink-faint)]">{new Date(f.createdAt).toLocaleString()}</span>
              </summary>
              <div className="mt-3 flex flex-col gap-2">
                {f.error && (
                  <p className="rounded-lg border border-[var(--band-c1)] bg-[var(--accent-soft)] p-2.5 text-[12px] leading-relaxed text-[var(--ink)]">
                    {f.error}
                  </p>
                )}
                <pre className="max-h-64 overflow-auto rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3 font-mono text-[11px] leading-relaxed text-[var(--ink-soft)]">
                  {JSON.stringify(f.output, null, 2)}
                </pre>
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  )
}

// A brief with cohort/placement rows but no curriculum row reads as clean in
// every other section on this page — briefsCovered counts it, and the
// failure log above stays empty if the missing step failed via a transport
// error on a sweep that predates adapter.ts logging those (see
// IncompleteBrief's doc comment in src/lib/evals.ts for the real incident
// this caught: brief 9's curriculum call failed with "fetch failed" and left
// zero trace in agent_runs). This section exists so that gap is never
// invisible — if the list is empty, every covered brief genuinely completed
// the full cohort -> placement -> curriculum chain.
function IncompleteBriefsSection({ s }: { s: Awaited<ReturnType<typeof loadEvalsSummary>> }) {
  if (s.incompleteBriefs.length === 0) return null
  return (
    <section className="flex flex-col gap-3">
      <SectionEyebrow>
        Incomplete briefs · {s.incompleteBriefs.length} brief{s.incompleteBriefs.length === 1 ? "" : "s"} did not
        finish the full chain
      </SectionEyebrow>
      <p className="text-[12px] leading-relaxed text-[var(--ink-soft)]">
        Each of these briefs has some real rows in this sweep, but is missing at least one of the three required
        generation steps (cohort → placement → curriculum) — most likely a transport error (a network failure,
        not a schema violation) that interrupted generation partway through. These briefs still count toward{" "}
        <code className="font-mono text-[12px]">briefsCovered</code> above, and a step that failed via a
        transport error on an older sweep may not appear in the failure log even though the brief genuinely
        did not complete — this section is the honest accounting for that gap.
      </p>
      <div className="flex flex-col gap-2">
        {s.incompleteBriefs.map(b => (
          <div
            key={b.label}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-dashed border-[var(--accent)] bg-[var(--accent-soft)] p-4 font-mono text-[11px]"
          >
            <span className="font-semibold text-[var(--ink)]">brief {b.label}</span>
            <span className="text-[var(--ink-soft)]">
              completed: {b.presentKinds.length > 0 ? b.presentKinds.join(", ") : "none"}
            </span>
            <span className="text-[var(--accent)]">missing: {b.missingKinds.join(", ")}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
