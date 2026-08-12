import Link from "next/link"
import { notFound } from "next/navigation"
import GenerateQbrButton from "@/components/GenerateQbrButton"
import PrintButton from "@/components/PrintButton"
import SimulatedTag from "@/components/SimulatedTag"
import { getQbrView, type QbrView } from "@/lib/program-view"
import type { QbrFacts } from "@/lib/qbr"

type RouteParams = { params: Promise<{ id: string }> }

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    dateStyle: "long",
    timeStyle: "short",
  })
}

export default async function QbrPage({ params }: RouteParams) {
  const { id: programId } = await params
  const result = await getQbrView(programId)

  if (result.status === "program_not_found") notFound()

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10 print:max-w-none print:px-0 print:py-0">
      <div className="mb-8 flex items-center justify-between gap-4 border-b border-[var(--line)] pb-4 print:hidden">
        <Link
          href={`/program/${programId}`}
          className="font-mono text-[11px] uppercase tracking-wide text-[var(--ink-faint)] transition-colors hover:text-[var(--accent)]"
        >
          ← Program overview
        </Link>
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ink-faint)]">
          Quarterly business review
        </p>
      </div>

      {result.status === "no_weeks_completed" && (
        <Refusal
          programId={programId}
          message="No weeks have been completed yet for this program — there is no quarter to review. Advance at least one week, then come back here."
        />
      )}

      {result.status === "not_generated" && (
        <div className="flex flex-col gap-4 rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-raised)] p-6">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
            Week {result.currentWeek} of {result.horizonWeeks} completed
          </p>
          <p className="text-base leading-relaxed text-[var(--ink)]">
            No QBR has been generated for this program yet. Generating one computes this quarter&apos;s
            facts from seeded session data and asks the model to write it up in one call — the result is
            saved, so reloading this page won&apos;t regenerate it.
          </p>
          <GenerateQbrButton programId={programId} />
        </div>
      )}

      {result.status === "ready" && <QbrReport view={result.data} />}
    </main>
  )
}

function Refusal({ programId, message }: { programId: string; message: string }) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-raised)] p-6">
      <p className="text-base leading-relaxed text-[var(--ink)]">{message}</p>
      <Link href={`/program/${programId}`} className="text-sm text-[var(--accent)] underline decoration-dotted">
        Go to the program overview
      </Link>
    </div>
  )
}

function QbrReport({ view }: { view: QbrView }) {
  const { facts } = view
  return (
    <article className="flex flex-col gap-10 print:gap-6">
      {/* Document header — brief, quarter, generated timestamp. Print-only
          masthead so a page printed with no browser chrome still identifies
          itself. */}
      <header className="flex flex-col gap-2 border-b border-[var(--line)] pb-6 print:break-inside-avoid print:border-b-2 print:border-[var(--ink)] print:pb-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
          Quarterly business review · Week {view.currentWeek} of {view.horizonWeeks}
        </p>
        <p className="max-w-2xl text-base leading-relaxed text-[var(--ink-soft)]">{view.brief}</p>
        <p className="font-mono text-[11px] text-[var(--ink-faint)]">Generated {fmtDate(view.generatedAt)}</p>
      </header>

      {/* Controls — screen only, stripped from print via print:hidden on
          the buttons themselves. */}
      <div className="-mt-6 flex items-center gap-3 print:hidden">
        <PrintButton />
        <GenerateQbrButton programId={view.programId} hasExisting />
        <p className="text-[11px] text-[var(--ink-faint)]">
          &quot;Print / save as PDF&quot; opens your browser&apos;s print dialog — that dialog&apos;s own
          &quot;Save as PDF&quot; destination is the export path. There is no separate PDF generator.
        </p>
      </div>

      {/* Headline + narrative — the model's business-language writeup over
          the facts below, never the source of any number on this page. */}
      <section className="flex flex-col gap-3 print:break-inside-avoid">
        <h1 className="font-display text-2xl italic leading-snug text-[var(--ink)] sm:text-[28px]">
          {view.headline}
        </h1>
        <p className="text-[15px] leading-relaxed text-[var(--ink-soft)]">{view.narrative}</p>
      </section>

      {/* Key metrics — every number here is computed in code from seeded
          session/score data (src/lib/qbr.ts), never by the model. Every one
          of them is a longitudinal figure built by ordering one real
          session per speaker into a week-over-week sequence, so every card
          carries SimulatedTag, per the standing project constraint. */}
      <section className="flex flex-col gap-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ink-faint)]">
          This quarter, by the numbers
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCard
            label="Completion"
            value={`${fmt(facts.completion.ratePct)}%`}
            detail={`${facts.completion.completedSessions} of ${facts.completion.totalSessions} sessions`}
          />
          <MetricCard
            label="Band movement"
            value={`${facts.bandMovement.up} up`}
            detail={`${facts.bandMovement.down} down · ${facts.bandMovement.same} unchanged`}
          />
          <MetricCard
            label="Most improved"
            value={facts.mostImproved.length > 0 ? facts.mostImproved[0].name : "—"}
            detail={
              facts.mostImproved.length > 0
                ? `${fmt(facts.mostImproved[0].from)} → ${fmt(facts.mostImproved[0].to)} (+${fmt(facts.mostImproved[0].deltaTotal)})`
                : "No learner improved this window"
            }
          />
          <MetricCard label="Currently at risk" value={String(facts.atRisk.length)} detail={`of ${facts.cohortSize} learners`} />
        </div>
      </section>

      {/* Wins and risks — grounded prose the model wrote against the facts
          above; the section CITES the numbers, it doesn't invent new ones. */}
      <div className="grid gap-6 sm:grid-cols-2">
        <NarrativeList title="Wins" items={view.wins} emptyText="No wins were called out this quarter." tone="win" />
        <NarrativeList title="Risks" items={view.risks} emptyText="No risks were flagged this quarter." tone="risk" />
      </div>

      <section className="flex flex-col gap-2 rounded-xl border border-[var(--line)] bg-[var(--paper-raised)] p-5 print:break-inside-avoid">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">Recommendation</p>
        <p className="text-[15px] leading-relaxed text-[var(--ink)]">{view.recommendation}</p>
      </section>

      {/* Appendix — the full per-learner detail behind the summary cards
          above, each figure re-tagged at the point of the claim. */}
      <BandMovementTable facts={facts} />
      <AtRiskList facts={facts} />

      <footer className="flex flex-col gap-2 border-t border-[var(--line)] pt-4 text-[11px] leading-relaxed text-[var(--ink-faint)] print:break-inside-avoid">
        <p>
          Band labels (A1–C1) are pronunciation-derived proxies computed from speechocean762 expert
          accuracy scores. They are <strong className="text-[var(--ink-soft)]">not CEFR proficiency assessments</strong>.
        </p>
        <p>
          Every figure marked <SimulatedTag className="mx-0.5" /> is constructed by ordering one real
          recorded session per speaker into a week-over-week sequence — the dataset has no real time
          dimension, so nothing on this page is a measurement taken over calendar time.
        </p>
      </footer>
    </article>
  )
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-[var(--line)] bg-[var(--paper-raised)] p-4 print:break-inside-avoid">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--ink-faint)]">{label}</span>
        <SimulatedTag />
      </div>
      <span className="truncate font-mono text-xl font-medium text-[var(--ink)]" title={value}>
        {value}
      </span>
      <span className="text-[11px] leading-snug text-[var(--ink-soft)]">{detail}</span>
    </div>
  )
}

function NarrativeList({
  title,
  items,
  emptyText,
  tone,
}: {
  title: string
  items: string[]
  emptyText: string
  tone: "win" | "risk"
}) {
  return (
    <section className="flex flex-col gap-3 print:break-inside-avoid">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ink-faint)]">{title}</p>
      {items.length === 0 ? (
        <p className="text-sm text-[var(--ink-faint)]">{emptyText}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item, i) => (
            <li
              key={i}
              className="flex gap-2 rounded-xl border border-[var(--line)] bg-[var(--paper-raised)] px-3.5 py-2.5 text-sm leading-relaxed text-[var(--ink)] print:break-inside-avoid"
            >
              <span className={tone === "win" ? "text-[var(--band-b2)]" : "text-[var(--accent)]"} aria-hidden="true">
                {tone === "win" ? "+" : "!"}
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function BandMovementTable({ facts }: { facts: QbrFacts }) {
  if (facts.bandMovement.perLearner.length === 0) return null
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ink-faint)]">
          Band movement · first known score vs. most recent, this quarter
        </p>
        <SimulatedTag />
      </div>
      <div className="flex flex-col divide-y divide-[var(--line)] overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-raised)]">
        {facts.bandMovement.perLearner.map(m => (
          <div key={m.learnerId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 print:break-inside-avoid">
            <span className="text-sm text-[var(--ink)]">{m.name}</span>
            <span className="flex items-center gap-2 font-mono text-[12px] text-[var(--ink-soft)]">
              {m.startBand} → {m.endBand}
              <span
                className={
                  m.direction === "up"
                    ? "font-medium text-[var(--band-b2)]"
                    : m.direction === "down"
                      ? "font-medium text-[var(--accent)]"
                      : "font-medium text-[var(--ink-faint)]"
                }
              >
                ({m.direction})
              </span>
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

function AtRiskList({ facts }: { facts: QbrFacts }) {
  if (facts.atRisk.length === 0) return null
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ink-faint)]">
          Currently at risk · {facts.atRisk.length}
        </p>
        <SimulatedTag />
      </div>
      <p className="text-sm leading-relaxed text-[var(--ink-soft)]">
        {facts.atRisk.map(a => a.name).join(", ")}
      </p>
    </section>
  )
}
