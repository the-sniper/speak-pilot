import type { MovementEntry, WeekBriefLearner } from "@/lib/program-view"
import SimulatedTag from "./SimulatedTag"

type Props = {
  n: number
  theme: string
  managerBrief: string | null
  onTrack: WeekBriefLearner[]
  slipped: WeekBriefLearner[]
  atRisk: WeekBriefLearner[]
  adjustments: { weekN: number; change: string; reason: string }[]
  movement: MovementEntry[]
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

function learnerLabel(l: WeekBriefLearner): string {
  return l.name ?? l.id
}

export default function WeekBrief({ n, theme, managerBrief, onTrack, slipped, atRisk, adjustments, movement }: Props) {
  return (
    <div className="flex flex-col gap-8">
      {/* The Monday brief itself — plain sentences, large type, nothing
          technical. This is what a non-technical manager reads first and,
          on a busy morning, possibly only. It asserts a week-over-week
          trend in prose, same as the movement figures below it, but had no
          local disclosure of its own — the footer/banner-level caveat
          exists elsewhere in the app, not on this card. Fix round 1 on
          Task 14, Finding 2 (same gap found on the QBR's narrative block,
          applied here too since the fix is a clean one-line addition). */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
            Week {n} · {theme}
          </p>
          {managerBrief && <SimulatedTag />}
        </div>
        {managerBrief ? (
          <p className="font-display text-2xl italic leading-snug text-[var(--ink)] sm:text-[28px]">
            {managerBrief}
          </p>
        ) : (
          <p className="text-[var(--ink-faint)]">No brief was written for this week.</p>
        )}
      </section>

      {/* Three counters, derived from the persisted onTrack/slipped/atRisk
          arrays only — never recounted from any other source. */}
      <section className="grid grid-cols-3 gap-3">
        <Counter label="On track" count={onTrack.length} learners={onTrack} tone="neutral" />
        <Counter label="Slipped" count={slipped.length} learners={slipped} tone="warn" />
        <Counter label="At risk" count={atRisk.length} learners={atRisk} tone="warn" />
      </section>

      {/* Score movement — a week-over-week figure. The dataset has no real
          time dimension, so every number here is constructed by ordering
          real utterances, not measured over calendar time — SimulatedTag
          marks the section AND, per the standing project constraint, each
          individual movement number below it. */}
      {movement.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ink-faint)]">
              Score movement vs. last week
            </p>
            <SimulatedTag />
          </div>
          <div className="flex flex-col divide-y divide-[var(--line)] overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-raised)]">
            {movement.map(m => (
              <div key={m.learnerId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                <span className="text-sm text-[var(--ink)]">{learnerLabel(m.learner)}</span>
                <span className="flex items-center gap-2 font-mono text-[12px] text-[var(--ink-soft)]">
                  {fmt(m.from)} → {fmt(m.to)}{" "}
                  <span
                    className={m.deltaTotal < 0 ? "font-medium text-[var(--accent)]" : "font-medium text-[var(--ink)]"}
                  >
                    ({m.deltaTotal >= 0 ? "+" : ""}
                    {fmt(m.deltaTotal)})
                  </span>
                  <SimulatedTag />
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Curriculum adjustments, each with its reason. */}
      <section className="flex flex-col gap-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ink-faint)]">
          Curriculum adjustments
        </p>
        {adjustments.length === 0 ? (
          <p className="text-sm text-[var(--ink-faint)]">No adjustments proposed this week.</p>
        ) : (
          <div className="flex flex-col divide-y divide-[var(--line)] overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-raised)]">
            {adjustments.map((a, i) => (
              <div key={i} className="flex flex-col gap-1 px-4 py-3.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-[var(--accent)]">Week {a.weekN}</span>
                  <span className="text-sm font-medium text-[var(--ink)]">{a.change}</span>
                </div>
                <p className="text-[12px] text-[var(--ink-faint)]">{a.reason}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function Counter({
  label,
  count,
  learners,
  tone,
}: {
  label: string
  count: number
  learners: WeekBriefLearner[]
  tone: "neutral" | "warn"
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--paper-raised)] p-4">
      <span
        className={`font-mono text-3xl font-medium ${tone === "warn" && count > 0 ? "text-[var(--accent)]" : "text-[var(--ink)]"}`}
      >
        {count}
      </span>
      <span className="font-mono text-[11px] uppercase tracking-wide text-[var(--ink-faint)]">{label}</span>
      {count > 0 && (
        <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-[var(--ink-soft)]">
          {learners.map(learnerLabel).join(", ")}
        </p>
      )}
    </div>
  )
}
