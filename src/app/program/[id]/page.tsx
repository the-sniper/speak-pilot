import Link from "next/link"
import { notFound } from "next/navigation"
import AdvanceButton from "@/components/AdvanceButton"
import PageHeader, { NavLink } from "@/components/PageHeader"
import SimulatedTag from "@/components/SimulatedTag"
import { getProgramOverview, type ProgramWeekSummary, type TrajectoryPoint } from "@/lib/program-view"

type RouteParams = { params: Promise<{ id: string }> }

export default async function ProgramPage({ params }: RouteParams) {
  const { id: programId } = await params
  const overview = await getProgramOverview(programId)
  if (!overview) notFound()

  const nextWeek = overview.currentWeek + 1
  const canAdvance = overview.currentWeek < overview.horizonWeeks
  const progressPct = Math.round((overview.currentWeek / overview.horizonWeeks) * 100)

  return (
    <main className="mx-auto w-full max-w-[1400px] px-4 py-8 sm:px-6 sm:py-10">
      <PageHeader
        label="Program"
        actions={
          <>
            <NavLink href={`/program/${programId}/qbr`}>Quarterly review</NavLink>
            <NavLink href="/">Home</NavLink>
          </>
        }
      >
        <p className="max-w-3xl text-lg font-medium leading-relaxed text-[var(--ink)] sm:text-xl">
          {overview.brief}
        </p>
      </PageHeader>

      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        <StatCard label="Week" value={`${overview.currentWeek} / ${overview.horizonWeeks}`} />
        <StatCard label="Progress" value={`${progressPct}%`} />
        <StatCard
          label="Next action"
          value={canAdvance ? `Advance week ${nextWeek}` : "Complete"}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-12">
        <div className="flex flex-col gap-6 lg:col-span-7">
          <TrajectorySection trajectory={overview.trajectory} />

          <section className="rounded-3xl border border-[var(--line)] bg-[var(--navy)] p-6 text-white">
            <h2 className="font-display text-lg font-extrabold tracking-tight">Weekly advance</h2>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-white/65">
              Computes this week&apos;s facts from seeded session data, writes the Monday brief, and drafts any
              outreach that needs a human&apos;s sign-off. In production this would run on a schedule.
            </p>
            <div className="mt-5">
              {canAdvance ? (
                <AdvanceButton
                  programId={overview.id}
                  targetWeek={nextWeek}
                  redirectToWeek
                  label={`Advance to week ${nextWeek}`}
                />
              ) : (
                <p className="font-mono text-[12px] text-white/55">
                  Program complete - every week through the {overview.horizonWeeks}-week horizon has been advanced.
                </p>
              )}
            </div>
          </section>
        </div>

        <section className="flex flex-col gap-3 lg:col-span-5">
          <h2 className="font-display text-lg font-extrabold tracking-tight text-[var(--ink)]">
            Weeks
          </h2>
          <div className="flex flex-col gap-2">
            {overview.weeks.map((w, i) => (
              <WeekTile key={i} programId={programId} week={w} />
            ))}
          </div>
        </section>
      </div>
    </main>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-[var(--paper-raised)] px-4 py-3.5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-faint)]">{label}</p>
      <p className="mt-1 font-display text-xl font-extrabold tracking-tight text-[var(--ink)]">{value}</p>
    </div>
  )
}

function WeekTile({ programId, week }: { programId: string; week: ProgramWeekSummary }) {
  const advanced = week.advancedAt !== null
  return (
    <Link
      href={`/program/${programId}/week/${week.n}`}
      className={`flex items-center justify-between gap-3 rounded-2xl border px-4 py-3.5 transition-colors ${
        advanced
          ? "border-[var(--line)] bg-[var(--paper-raised)] hover:border-[var(--accent)]"
          : "border-dashed border-[var(--line)] bg-transparent hover:border-[var(--ink-faint)]"
      }`}
    >
      <div className="min-w-0">
        <p className="font-mono text-[11px] text-[var(--ink-faint)]">Week {week.n}</p>
        <p className={`truncate text-sm font-semibold ${advanced ? "text-[var(--ink)]" : "text-[var(--ink-faint)]"}`}>
          {week.theme}
        </p>
      </div>
      <span
        className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${
          advanced ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "bg-[var(--paper)] text-[var(--ink-faint)]"
        }`}
      >
        {advanced ? "Ready" : "Pending"}
      </span>
    </Link>
  )
}

function TrajectorySection({ trajectory }: { trajectory: TrajectoryPoint[] }) {
  return (
    <section className="rounded-3xl border border-[var(--line)] bg-[var(--paper-raised)] p-5 sm:p-6">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="font-display text-lg font-extrabold tracking-tight text-[var(--ink)]">
          Cohort trajectory
        </h2>
        <SimulatedTag />
      </div>
      <p className="mb-4 text-sm text-[var(--ink-faint)]">Mean sentence score by week</p>
      {trajectory.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--line)] bg-[var(--paper)] p-5 text-sm text-[var(--ink-faint)]">
          No weeks advanced yet - advance week 1 to start the trajectory.
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
    <div>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1.5">
        <span className="flex items-baseline gap-1.5 whitespace-nowrap">
          <span className="font-mono text-2xl font-medium text-[var(--ink)]">{last.meanTotal.toFixed(1)}</span>
          <SimulatedTag />
        </span>
        <span
          className={`flex items-baseline gap-1.5 whitespace-nowrap font-mono text-sm font-medium ${delta < 0 ? "text-[var(--accent)]" : "text-[var(--ink-soft)]"}`}
        >
          {delta >= 0 ? "+" : ""}
          {delta.toFixed(1)} since week {first.weekN}
          <SimulatedTag />
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Cohort mean sentence score by week, constructed trajectory">
        <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        {trajectory.map((p, i) => (
          <circle key={p.weekN} cx={x(i)} cy={y(p.meanTotal)} r="4" fill="var(--accent)" />
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
