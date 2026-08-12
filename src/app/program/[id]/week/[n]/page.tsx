import Link from "next/link"
import { notFound } from "next/navigation"
import AdvanceButton from "@/components/AdvanceButton"
import DraftCard from "@/components/DraftCard"
import WeekBrief from "@/components/WeekBrief"
import { getWeekBrief } from "@/lib/program-view"

type RouteParams = { params: Promise<{ id: string; n: string }> }

export default async function WeekPage({ params }: RouteParams) {
  const { id: programId, n: nParam } = await params
  const n = Number(nParam)

  if (!Number.isInteger(n) || n < 1) notFound()

  const result = await getWeekBrief(programId, n)

  if (result.status === "program_not_found" || result.status === "week_not_found") {
    notFound()
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <div className="mb-8 flex items-center justify-between gap-4 border-b border-[var(--line)] pb-4">
        <Link
          href={`/program/${programId}`}
          className="font-mono text-[11px] uppercase tracking-wide text-[var(--ink-faint)] transition-colors hover:text-[var(--accent)]"
        >
          ← Program overview
        </Link>
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ink-faint)]">
          Monday brief
        </p>
      </div>

      {result.status === "not_advanced" ? (
        <NotAdvanced result={result} />
      ) : (
        <div className="flex flex-col gap-10">
          <WeekBrief
            n={result.data.n}
            theme={result.data.theme}
            managerBrief={result.data.managerBrief}
            onTrack={result.data.onTrack}
            slipped={result.data.slipped}
            atRisk={result.data.atRisk}
            adjustments={result.data.adjustments}
            movement={result.data.movement}
          />

          <section className="flex flex-col gap-3">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ink-faint)]">
              Drafts · {result.data.drafts.length} awaiting review
            </p>
            {result.data.drafts.length === 0 ? (
              <p className="text-sm text-[var(--ink-faint)]">No outreach was drafted for this week.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {result.data.drafts.map(d => (
                  <DraftCard key={d.id} draft={d} />
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  )
}

function NotAdvanced({
  result,
}: {
  result: { programId: string; n: number; theme: string; currentWeek: number; horizonWeeks: number }
}) {
  const isNext = result.n === result.currentWeek + 1
  const isPast = result.n <= result.currentWeek

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-raised)] p-6">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
        Week {result.n} · {result.theme}
      </p>
      <p className="text-base leading-relaxed text-[var(--ink)]">
        {isPast
          ? "This week doesn't have a brief yet, even though later weeks might — that shouldn't happen. Try advancing from the program overview."
          : "This week hasn't been advanced yet. There is no brief, no counters, and no drafts until it is."}
      </p>
      {isNext ? (
        <AdvanceButton
          programId={result.programId}
          targetWeek={result.n}
          label={`Advance to week ${result.n}`}
        />
      ) : (
        <p className="text-sm text-[var(--ink-faint)]">
          Weeks advance in order — week {result.currentWeek + 1} needs to be advanced first.{" "}
          <Link href={`/program/${result.programId}`} className="text-[var(--accent)] underline decoration-dotted">
            Go to the program overview
          </Link>
          .
        </p>
      )}
    </div>
  )
}
