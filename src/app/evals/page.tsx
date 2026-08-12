import Link from "next/link"
import { BAND_TABLE } from "@/lib/bands"
import { loadEvalsSummary } from "@/lib/evals"

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

export default async function EvalsPage() {
  const s = await loadEvalsSummary()
  const hasSweepData = s.sweepRunCount > 0

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
          the table every LLM attempt writes to, successes and failures alike — scoped to the
          {" "}{s.totalBriefs} briefs in <code className="font-mono text-[12px]">docs/eval-briefs.ts</code>
          {" "}(Appendix B), run by <code className="font-mono text-[12px]">scripts/run-evals.ts</code>.
        </p>
      </div>

      <MockBanner isMock={s.isMock} provider={s.provider} />

      <div className="mt-8 flex flex-col gap-8">
        <SweepStatus s={s} />

        {!hasSweepData ? (
          <div className="rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-raised)] p-6 text-sm text-[var(--ink-faint)]">
            No eval sweep has been run yet — nothing in <code className="font-mono text-[12px]">agent_runs</code>{" "}
            carries a <code className="font-mono text-[12px]">brief_label</code>. Run{" "}
            <code className="font-mono text-[12px]">npm run evals</code> to populate this page.
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
          </>
        )}
      </div>
    </main>
  )
}

function MockBanner({ isMock, provider }: { isMock: boolean; provider: string }) {
  if (!isMock) {
    return (
      <div className="flex flex-col gap-1 rounded-xl border border-[var(--line)] bg-[var(--paper-raised)] p-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
          Provider: {provider}
        </p>
        <p className="text-sm leading-relaxed text-[var(--ink-soft)]">
          The numbers below are a real, measured eval sweep against this provider.
        </p>
      </div>
    )
  }
  return (
    <div
      data-mock-banner=""
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
          Not yet measured — provider is mock
        </p>
      </div>
      <p className="text-sm leading-relaxed text-[var(--ink)]">
        <code className="font-mono text-[12px]">LLM_PROVIDER=mock</code>. Every number below comes from the
        deterministic mock provider — fixture output that always validates and always costs $0 — not from a
        real model. It measures the harness (does the retry loop work, does every attempt land in{" "}
        <code className="font-mono text-[12px]">agent_runs</code>, does the page render honestly) and nothing
        about real model quality. A live API key is configured but deliberately unused here; the real eval
        sweep is a separate, later step, run once and reported as such.
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

function MetricCard({
  eyebrow, value, caption, wide,
}: {
  eyebrow: string
  value: string
  caption?: string
  wide?: boolean
}) {
  return (
    <div
      className={`flex flex-col gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--paper-raised)] p-5 ${wide ? "sm:col-span-2" : ""}`}
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--ink-faint)]">{eyebrow}</p>
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
        />
        <MetricCard
          eyebrow="Valid after retry"
          value={pct(c.afterRetry)}
          caption="Fraction of logical calls that eventually validated, first try or one retry."
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
        <MetricCard eyebrow="Exact band match" value={p.n > 0 ? pct(p.exact) : "—"} />
        <MetricCard eyebrow="Within one band" value={p.n > 0 ? pct(p.withinOne) : "—"} />
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
  const { latency, cost } = s
  return (
    <section className="flex flex-col gap-3">
      <SectionEyebrow>Latency &amp; cost</SectionEyebrow>
      <div className="grid gap-3 sm:grid-cols-2">
        <MetricCard eyebrow="p50 latency" value={fmtMs(latency.p50)} />
        <MetricCard eyebrow="p95 latency" value={fmtMs(latency.p95)} />
        <MetricCard
          eyebrow="Mean cost, priced calls"
          value={cost.meanKnownCost === null ? "cost unknown" : fmtCost(cost.meanKnownCost)}
          caption={`${cost.knownCount} call${cost.knownCount === 1 ? "" : "s"} with a known cost (0 = genuinely free — mock or a cache hit; never fabricated).`}
        />
        <MetricCard
          eyebrow="Unpriced calls"
          value={cost.unknownCount > 0 ? String(cost.unknownCount) : "0"}
          caption={
            cost.unknownCount > 0
              ? "A real call happened on a model whose price isn't configured — reported as unknown, never as $0.00."
              : "Every logged call had a known cost."
          }
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
        />
        <MetricCard
          eyebrow="Judge / human agreement"
          value={r.agreement === null ? "not available" : pct(r.agreement)}
          caption={`${r.humanLabeledCount} of ${r.totalBriefs} briefs have a human label.`}
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
