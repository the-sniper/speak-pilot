import Link from "next/link"
import { notFound } from "next/navigation"
import AdvanceButton from "@/components/AdvanceButton"
import SimulatedTag from "@/components/SimulatedTag"
import { getProgramOverview, type ProgramWeekSummary, type TrajectoryPoint } from "@/lib/program-view"

type RouteParams = { params: Promise<{ id: string }> }

export default async function ProgramPage({ params }: RouteParams) {
  const { id: programId } = await params
  const overview = await getProgramOverview(programId)
  if (!overview) notFound()

  const nextWeek = overview.currentWeek + 1
  const canAdvance = overview.currentWeek < overview.horizonWeeks

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10">
      <div className="mb-10 flex flex-col gap-3 border-b border-[var(--line)] pb-6">
        <div className="flex items-center justify-between gap-4">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">Program</p>
          <Link
            href="/"
            className="font-mono text-[11px] uppercase tracking-wide text-[var(--ink-faint)] transition-colors hover:text-[var(--accent)]"
          >
            ← Home
          </Link>
        </div>
        <p className="max-w-2xl text-lg leading-relaxed text-[var(--ink)]">{overview.brief}</p>
        <p className="font-mono text-[12px] text-[var(--ink-soft)]">
          Week {overview.currentWeek} of {overview.horizonWeeks} completed
        </p>
      </div>

      <div className="flex flex-col gap-10">
        <TrajectorySection trajectory={overview.trajectory} />

        <section className="flex flex-col gap-3">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ink-faint)]">
            Weeks · {overview.horizonWeeks}-week horizon
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {overview.weeks.map((w, i) => (
              // Index, not w.n, is the React key: w.n is model-authored
              // curriculum content (from the generation step, Task 9), not a
              // guaranteed-unique identity — the mock provider can and does
              // repeat it, same caveat ProgramStream's WeeksSection already
              // documents for this exact field.
              <WeekTile key={i} programId={programId} week={w} />
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-raised)] p-5">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ink-faint)]">
            Weekly advance
          </p>
          <p className="max-w-xl text-sm text-[var(--ink-soft)]">
            Computes this week&apos;s facts from seeded session data, writes the Monday brief, and drafts any
            outreach that needs a human&apos;s sign-off before it goes anywhere. In production this would run on a
            schedule; here it&apos;s a button so you can watch each week land.
          </p>
          {canAdvance ? (
            <AdvanceButton programId={overview.id} targetWeek={nextWeek} redirectToWeek label={`Advance to week ${nextWeek}`} />
          ) : (
            <p className="font-mono text-[12px] text-[var(--ink-faint)]">
              Program complete — every week through the {overview.horizonWeeks}-week horizon has been advanced.
            </p>
          )}
        </section>
      </div>
    </main>
  )
}

function WeekTile({ programId, week }: { programId: string; week: ProgramWeekSummary }) {
  const advanced = week.advancedAt !== null
  return (
    <Link
      href={`/program/${programId}/week/${week.n}`}
      className={`flex flex-col gap-1 rounded-xl border px-4 py-3 transition-colors ${
        advanced
          ? "border-[var(--line)] bg-[var(--paper-raised)] hover:border-[var(--accent)]"
          : "border-dashed border-[var(--line)] bg-transparent text-[var(--ink-faint)] hover:border-[var(--ink-faint)]"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-[var(--ink-faint)]">Week {week.n}</span>
        <span
          className={`font-mono text-[10px] uppercase tracking-wide ${advanced ? "text-[var(--accent)]" : "text-[var(--ink-faint)]"}`}
        >
          {advanced ? "brief ready" : "not advanced"}
        </span>
      </div>
      <span className={`text-sm ${advanced ? "text-[var(--ink)]" : "text-[var(--ink-faint)]"}`}>{week.theme}</span>
    </Link>
  )
}

function TrajectorySection({ trajectory }: { trajectory: TrajectoryPoint[] }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ink-faint)]">
          Cohort trajectory · mean sentence score
        </p>
        <SimulatedTag />
      </div>
      {trajectory.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-raised)] p-5 text-sm text-[var(--ink-faint)]">
          No weeks advanced yet — advance week 1 below to start the trajectory.
        </div>
      ) : (
        <TrajectoryChart trajectory={trajectory} />
      )}
    </section>
  )
}

function TrajectoryChart({ trajectory }: { trajectory: TrajectoryPoint[] }) {
  const width = 640
  const height = 160
  const padX = 28
  const padY = 20

  const values = trajectory.map(p => p.meanTotal)
  const rawMin = Math.min(...values)
  const rawMax = Math.max(...values)
  const span = rawMax - rawMin || 1
  const min = rawMin - span * 0.15
  const max = rawMax + span * 0.15

  const first = trajectory[0]
  const last = trajectory[trajectory.length - 1]
  const delta = Math.round((last.meanTotal - first.meanTotal) * 100) / 100

  const x = (i: number) =>
    trajectory.length === 1 ? width / 2 : padX + (i / (trajectory.length - 1)) * (width - padX * 2)
  const y = (v: number) => height - padY - ((v - min) / (max - min)) * (height - padY * 2)

  const linePath = trajectory.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.meanTotal).toFixed(1)}`).join(" ")

  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-raised)] p-5">
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-2xl font-medium text-[var(--ink)]">{last.meanTotal.toFixed(1)}</span>
        <span className={`font-mono text-sm font-medium ${delta < 0 ? "text-[var(--accent)]" : "text-[var(--ink-soft)]"}`}>
          {delta >= 0 ? "+" : ""}
          {delta.toFixed(1)} since week {first.weekN}
        </span>
        <SimulatedTag />
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Cohort mean sentence score by week, constructed trajectory">
        <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {trajectory.map((p, i) => (
          <circle key={p.weekN} cx={x(i)} cy={y(p.meanTotal)} r="3.5" fill="var(--accent)" />
        ))}
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-[var(--ink-faint)]">
        {trajectory.map(p => (
          <span key={p.weekN}>Wk {p.weekN}</span>
        ))}
      </div>
    </div>
  )
}
