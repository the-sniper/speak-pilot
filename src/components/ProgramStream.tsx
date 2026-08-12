"use client"

import { useEffect, useReducer, useState, type ReactNode } from "react"
import { z } from "zod"
import { BANDS } from "@/lib/bands"
import { CohortSchema, CurriculumSchema, Placement as PlacementSchema } from "@/lib/schemas"
import PlacementCard, { BAND_BG, BAND_FG, type PlacementCardData } from "./PlacementCard"

// Every payload type below is inferred straight from the same zod schemas
// the server validates against (src/lib/schemas.ts) — the client can't drift
// from the contract because there's only one definition of it.
type Cohort = z.infer<typeof CohortSchema>
type Week = z.infer<typeof CurriculumSchema.shape.weeks>[number]
type Cadence = z.infer<typeof CurriculumSchema.shape.cadence>
type Criterion = z.infer<typeof CurriculumSchema.shape.successCriteria>[number]
type Kickoff = z.infer<typeof CurriculumSchema.shape.kickoffMessage>

const SECTION_ORDER = ["cohort", "placements", "weeks", "cadence", "successCriteria", "kickoff"] as const
type SectionKey = (typeof SECTION_ORDER)[number]

type State = {
  cohort?: Cohort
  placements?: PlacementCardData[]
  weeks?: Week[]
  cadence?: Cadence
  successCriteria?: Criterion[]
  kickoff?: Kickoff
  error?: string
  done: boolean
}

type Action =
  | { type: "section"; key: "cohort"; payload: Cohort }
  | { type: "section"; key: "placements"; payload: PlacementCardData[] }
  | { type: "section"; key: "weeks"; payload: Week[] }
  | { type: "section"; key: "cadence"; payload: Cadence }
  | { type: "section"; key: "successCriteria"; payload: Criterion[] }
  | { type: "section"; key: "kickoff"; payload: Kickoff }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "reset" }

const initialState: State = { done: false }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "reset":
      return initialState
    case "done":
      return { ...state, done: true }
    case "error":
      return { ...state, error: action.message }
    case "section":
      switch (action.key) {
        case "cohort":
          return { ...state, cohort: action.payload }
        case "placements":
          return { ...state, placements: action.payload }
        case "weeks":
          return { ...state, weeks: action.payload }
        case "cadence":
          return { ...state, cadence: action.payload }
        case "successCriteria":
          return { ...state, successCriteria: action.payload }
        case "kickoff":
          return { ...state, kickoff: action.payload }
      }
  }
}

function parseFrame(raw: string): { event: string; data: unknown } | null {
  let event = "message"
  let dataLine: string | null = null
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim()
    else if (line.startsWith("data:")) dataLine = line.slice("data:".length).trim()
  }
  if (dataLine === null) return null
  try {
    return { event, data: JSON.parse(dataLine) }
  } catch {
    return null
  }
}

type Props = {
  brief: string
  onProgramId: (id: string) => void
}

export default function ProgramStream({ brief, onProgramId }: Props) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    dispatch({ type: "reset" })

    async function run() {
      try {
        const res = await fetch("/api/programs/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brief }),
          signal: controller.signal,
        })
        if (!res.ok || !res.body) {
          throw new Error(`The program couldn't be generated (server responded ${res.status}).`)
        }

        // fetch + getReader, not EventSource — EventSource can only GET, and
        // this endpoint takes the brief as a POST body (build guide / task
        // brief requirement).
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          // SSE frames are separated by a blank line; a frame can arrive
          // split across chunks, so only consume complete frames out of the
          // buffer and leave any trailing partial frame for the next read.
          let sepIndex: number
          while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
            const rawFrame = buffer.slice(0, sepIndex)
            buffer = buffer.slice(sepIndex + 2)
            if (cancelled || !rawFrame.trim()) continue

            const frame = parseFrame(rawFrame)
            if (!frame) continue

            if (frame.event === "section") {
              const raw = frame.data as { key?: string; payload?: unknown }
              switch (raw.key) {
                case "cohort": {
                  const parsed = CohortSchema.safeParse(raw.payload)
                  if (parsed.success) dispatch({ type: "section", key: "cohort", payload: parsed.data })
                  break
                }
                case "placements": {
                  const parsed = z.array(PlacementSchema).safeParse(raw.payload)
                  if (parsed.success) dispatch({ type: "section", key: "placements", payload: parsed.data })
                  break
                }
                case "weeks": {
                  const parsed = CurriculumSchema.shape.weeks.safeParse(raw.payload)
                  if (parsed.success) dispatch({ type: "section", key: "weeks", payload: parsed.data })
                  break
                }
                case "cadence": {
                  const parsed = CurriculumSchema.shape.cadence.safeParse(raw.payload)
                  if (parsed.success) dispatch({ type: "section", key: "cadence", payload: parsed.data })
                  break
                }
                case "successCriteria": {
                  const parsed = CurriculumSchema.shape.successCriteria.safeParse(raw.payload)
                  if (parsed.success) dispatch({ type: "section", key: "successCriteria", payload: parsed.data })
                  break
                }
                case "kickoff": {
                  const parsed = CurriculumSchema.shape.kickoffMessage.safeParse(raw.payload)
                  if (parsed.success) dispatch({ type: "section", key: "kickoff", payload: parsed.data })
                  break
                }
              }
            } else if (frame.event === "done") {
              dispatch({ type: "done" })
              const data = frame.data as { programId?: string }
              if (data.programId) onProgramId(data.programId)
            } else if (frame.event === "error") {
              const data = frame.data as { message?: string }
              dispatch({ type: "error", message: data.message ?? "The program generator returned an error." })
            }
          }
        }
      } catch (err) {
        if (cancelled || controller.signal.aborted) return
        const message =
          err instanceof Error ? err.message : "Something went wrong while generating the program."
        dispatch({ type: "error", message })
      }
    }

    run()
    return () => {
      cancelled = true
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onProgramId is a stable callback identity from the parent; re-running on it would restart the stream.
  }, [brief, attempt])

  if (state.error) {
    return <ErrorCard message={state.error} onRetry={() => setAttempt(a => a + 1)} />
  }

  return (
    <div className="flex w-full flex-col gap-12">
      {state.cohort ? <CohortCard cohort={state.cohort} /> : <SectionSkeleton kind="cohort" />}

      {state.cohort &&
        (state.placements ? (
          <PlacementsSection placements={state.placements} />
        ) : (
          <SectionSkeleton kind="placements" />
        ))}

      {state.placements &&
        (state.weeks ? <WeeksSection weeks={state.weeks} /> : <SectionSkeleton kind="weeks" />)}

      {state.weeks &&
        (state.cadence ? <CadenceCard cadence={state.cadence} /> : <SectionSkeleton kind="cadence" />)}

      {state.cadence &&
        (state.successCriteria ? (
          <SuccessCriteriaCard items={state.successCriteria} />
        ) : (
          <SectionSkeleton kind="successCriteria" />
        ))}

      {state.successCriteria &&
        (state.kickoff ? <KickoffCard kickoff={state.kickoff} /> : <SectionSkeleton kind="kickoff" />)}
    </div>
  )
}

function SectionShell({ eyebrow, children }: { eyebrow: string; children: ReactNode }) {
  return (
    <section className="animate-rise-in flex flex-col gap-4">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">{eyebrow}</p>
      {children}
    </section>
  )
}

function DataChip({ label }: { label: string }) {
  return (
    <span className="rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1 font-mono text-[11px] text-[var(--ink-soft)]">
      {label}
    </span>
  )
}

function CohortCard({ cohort }: { cohort: Cohort }) {
  return (
    <SectionShell eyebrow="Cohort">
      <p className="font-display text-2xl leading-snug text-[var(--ink)] sm:text-[28px]">{cohort.understanding}</p>
      <div className="flex flex-wrap gap-2">
        <DataChip label={`${cohort.size} learners`} />
        <DataChip label={cohort.l1} />
        <DataChip label={cohort.role} />
        <DataChip label={`${cohort.horizonWeeks}-week horizon`} />
      </div>
    </SectionShell>
  )
}

function PlacementsSection({ placements }: { placements: PlacementCardData[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = placements.find(p => p.learnerId === selectedId) ?? null

  return (
    <SectionShell eyebrow={`Placements · ${placements.length} learners`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-1.5">
          {BANDS.map(b => (
            <span
              key={b}
              className="rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium"
              style={{ background: BAND_BG[b], color: BAND_FG[b] }}
            >
              {b}
            </span>
          ))}
        </div>
        {/* Standing project constraint: bands are pronunciation-derived proxies,
            never presented as a CEFR assessment — this caveat lives right next
            to the legend on the one screen every band label appears on. */}
        <p className="text-[11px] text-[var(--ink-faint)]">
          Bands are pronunciation-derived proxies from speechocean762 expert scores, not CEFR assessments.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {placements.map((p, i) => (
          <PlacementCard
            key={p.learnerId}
            placement={p}
            selected={p.learnerId === selectedId}
            onSelect={id => setSelectedId(cur => (cur === id ? null : id))}
            style={{ animationDelay: `${Math.min(i * 22, 380)}ms` }}
          />
        ))}
      </div>

      {selected && (
        <div className="animate-rise-in rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] p-4">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="font-mono text-xs text-[var(--ink)]">{selected.learnerId}</span>
            <span
              className="rounded-md px-1.5 py-0.5 font-mono text-[11px] font-medium"
              style={{ background: BAND_BG[selected.band], color: BAND_FG[selected.band] }}
            >
              {selected.band}
            </span>
          </div>
          <p className="text-sm text-[var(--ink)]">{selected.rationale}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {selected.evidenceUtteranceIds.map(id => (
              <span
                key={id}
                className="rounded border border-[var(--line)] bg-[var(--paper-raised)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ink-soft)]"
              >
                {id}
              </span>
            ))}
          </div>
        </div>
      )}
    </SectionShell>
  )
}

function WeeksSection({ weeks }: { weeks: Week[] }) {
  // Selected by array position, not week.n — n is model-authored content, not
  // a stable identity the UI can rely on being unique (the mock provider can
  // and does repeat it), so indexing by n would let two tiles collide onto
  // one selection and break React's keys. Position in the array is always
  // unique and is what "the second tile" actually means to a click.
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const activeIdx = selectedIdx ?? 0
  const activeWeek = weeks[activeIdx] ?? null

  return (
    <SectionShell eyebrow={`Curriculum · ${weeks.length} weeks`}>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {weeks.map((w, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setSelectedIdx(i)}
            style={{ animationDelay: `${Math.min(i * 30, 300)}ms` }}
            className={`animate-rise-in flex min-w-[132px] shrink-0 flex-col gap-1 rounded-xl border px-3.5 py-3 text-left transition-colors ${
              activeIdx === i
                ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                : "border-[var(--line)] bg-[var(--paper-raised)] hover:border-[var(--ink-faint)]"
            }`}
          >
            <span className="font-mono text-[11px] text-[var(--ink-faint)]">Week {w.n}</span>
            <span className="text-sm font-medium leading-snug text-[var(--ink)]">{w.theme}</span>
          </button>
        ))}
      </div>

      {activeWeek && (
        <div className="animate-rise-in grid gap-3 sm:grid-cols-2">
          {activeWeek.scenarios.map((s, i) => (
            <div key={i} className="rounded-xl border border-[var(--line)] bg-[var(--paper-raised)] p-4">
              <p className="font-display text-lg italic text-[var(--ink)]">{s.title}</p>
              <p className="mt-1 text-sm text-[var(--ink-soft)]">{s.situation}</p>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {s.targetPhrases.map((phrase, j) => (
                  <span
                    key={j}
                    className="rounded border border-[var(--line)] px-1.5 py-0.5 text-[11px] text-[var(--ink-soft)]"
                  >
                    {phrase}
                  </span>
                ))}
              </div>
              <p className="mt-2.5 text-[12px] text-[var(--ink-faint)]">
                <span className="font-mono uppercase tracking-wide">Success —</span> {s.successLooksLike}
              </p>
            </div>
          ))}
        </div>
      )}
    </SectionShell>
  )
}

function CadenceCard({ cadence }: { cadence: Cadence }) {
  return (
    <SectionShell eyebrow="Cadence">
      <p className="text-lg text-[var(--ink)]">
        <span className="font-mono text-xl font-medium text-[var(--accent)]">{cadence.sessionsPerWeek}</span>{" "}
        sessions a week,{" "}
        <span className="font-mono text-xl font-medium text-[var(--accent)]">{cadence.minutesPerSession}</span>{" "}
        minutes each.
      </p>
    </SectionShell>
  )
}

function SuccessCriteriaCard({ items }: { items: Criterion[] }) {
  return (
    <SectionShell eyebrow="Success criteria">
      <div className="flex flex-col divide-y divide-[var(--line)] overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-raised)]">
        {items.map((c, i) => (
          <div key={i} className="animate-rise-in px-4 py-3.5" style={{ animationDelay: `${i * 60}ms` }}>
            <p className="text-base text-[var(--ink)]">{c.plainLanguage}</p>
            <p className="mt-1 font-mono text-[11px] text-[var(--ink-faint)]">{c.measurableProxy}</p>
          </div>
        ))}
      </div>
    </SectionShell>
  )
}

function KickoffCard({ kickoff }: { kickoff: Kickoff }) {
  const [lang, setLang] = useState<"en" | "ko">("en")
  return (
    <SectionShell eyebrow="Kickoff message">
      <div className="flex items-center gap-1 self-start rounded-full border border-[var(--line)] bg-[var(--paper-raised)] p-1">
        {(["en", "ko"] as const).map(l => (
          <button
            key={l}
            type="button"
            onClick={() => setLang(l)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              lang === l ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "text-[var(--ink-soft)]"
            }`}
          >
            {l === "en" ? "EN" : "KO"}
          </button>
        ))}
      </div>
      <div className="rounded-xl border-l-4 border-[var(--accent)] bg-[var(--paper-raised)] p-5">
        <p className="whitespace-pre-wrap font-display text-lg italic leading-relaxed text-[var(--ink)]">
          {kickoff[lang]}
        </p>
      </div>
    </SectionShell>
  )
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="animate-rise-in flex flex-col gap-3 rounded-xl border border-[var(--band-c1)] bg-[var(--accent-soft)] p-5">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--band-c1)]">Generation failed</p>
      <p className="text-sm text-[var(--ink)]">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="self-start rounded-full bg-[var(--ink)] px-4 py-1.5 text-xs font-medium text-[var(--paper)]"
      >
        Try again
      </button>
    </div>
  )
}

function SectionSkeleton({ kind }: { kind: SectionKey }) {
  switch (kind) {
    case "cohort":
      return (
        <div className="flex flex-col gap-3">
          <div className="skeleton-shimmer h-3 w-20 rounded" />
          <div className="skeleton-shimmer h-7 w-4/5 rounded" />
          <div className="flex gap-2">
            <div className="skeleton-shimmer h-6 w-24 rounded-md" />
            <div className="skeleton-shimmer h-6 w-20 rounded-md" />
            <div className="skeleton-shimmer h-6 w-28 rounded-md" />
          </div>
        </div>
      )
    case "placements":
      return (
        <div className="flex flex-col gap-3">
          <div className="skeleton-shimmer h-3 w-32 rounded" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="skeleton-shimmer h-16 rounded-xl" />
            ))}
          </div>
        </div>
      )
    case "weeks":
      return (
        <div className="flex flex-col gap-3">
          <div className="skeleton-shimmer h-3 w-28 rounded" />
          <div className="flex gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton-shimmer h-16 w-[132px] shrink-0 rounded-xl" />
            ))}
          </div>
        </div>
      )
    case "cadence":
      return (
        <div className="flex flex-col gap-3">
          <div className="skeleton-shimmer h-3 w-16 rounded" />
          <div className="skeleton-shimmer h-6 w-64 rounded" />
        </div>
      )
    case "successCriteria":
      return (
        <div className="flex flex-col gap-3">
          <div className="skeleton-shimmer h-3 w-32 rounded" />
          <div className="skeleton-shimmer h-20 rounded-xl" />
        </div>
      )
    case "kickoff":
      return (
        <div className="flex flex-col gap-3">
          <div className="skeleton-shimmer h-3 w-28 rounded" />
          <div className="skeleton-shimmer h-24 rounded-xl" />
        </div>
      )
  }
}
