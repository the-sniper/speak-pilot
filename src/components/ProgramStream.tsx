"use client"

import Link from "next/link"
import { useEffect, useReducer, useState, type ReactNode } from "react"
import { z } from "zod"
import { BANDS } from "@/lib/bands"
import { CohortSchema, CurriculumSchema, Placement as PlacementSchema } from "@/lib/schemas"
import EvidencePanel from "./EvidencePanel"
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

const SECTION_LABEL: Record<SectionKey, string> = {
  cohort: "Cohort",
  placements: "Placements",
  weeks: "Curriculum",
  cadence: "Cadence",
  successCriteria: "Success",
  kickoff: "Kickoff",
}

type State = {
  cohort?: Cohort
  placements?: PlacementCardData[]
  weeks?: Week[]
  cadence?: Cadence
  successCriteria?: Criterion[]
  kickoff?: Kickoff
  error?: string
  done: boolean
  // The evidence panel needs the persisted program id to resolve a
  // placement's real DB row (see EvidencePanel / GET /api/placements). The
  // SSE `placements` section only carries the model's schema-validated
  // output — no DB-generated id — so this is only known once the `done`
  // frame arrives with it. Lives in this reducer (not a sibling useState)
  // so the effect below only ever dispatches, never calls a raw setState.
  programId?: string
}

type Action =
  | { type: "section"; key: "cohort"; payload: Cohort }
  | { type: "section"; key: "placements"; payload: PlacementCardData[] }
  | { type: "section"; key: "weeks"; payload: Week[] }
  | { type: "section"; key: "cadence"; payload: Cadence }
  | { type: "section"; key: "successCriteria"; payload: Criterion[] }
  | { type: "section"; key: "kickoff"; payload: Kickoff }
  | { type: "done"; programId: string }
  | { type: "error"; message: string }
  | { type: "reset" }

const initialState: State = { done: false }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "reset":
      return initialState
    case "done":
      return { ...state, done: true, programId: action.programId }
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

// A dropped frame must never fail silently: because rendering gates each
// section on the previous one being present (see renderSections below), one
// swallowed frame freezes every later section on its skeleton forever — the
// exact "permanent skeleton" failure mode the completion watchdog exists to
// catch. console.error here is the only diagnostic a developer gets for
// which frame was lost and why, so every failure path logs before giving up
// on that frame.
function logDroppedFrame(reason: string, detail: unknown) {
  console.error(`[ProgramStream] dropped an SSE frame — ${reason}`, detail)
}

function parseFrame(raw: string): { event: string; data: unknown } | null {
  let event = "message"
  let dataLine: string | null = null
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim()
    else if (line.startsWith("data:")) dataLine = line.slice("data:".length).trim()
  }
  if (dataLine === null) {
    logDroppedFrame("no \"data:\" line found in the frame", raw)
    return null
  }
  try {
    return { event, data: JSON.parse(dataLine) }
  } catch (err) {
    logDroppedFrame("data line was not valid JSON", { raw, err })
    return null
  }
}

function logSectionValidationFailure(key: string, error: unknown, payload: unknown) {
  logDroppedFrame(`"${key}" section payload failed client-side schema validation`, { error, payload })
}

type Props = {
  brief: string
  onProgramId: (id: string) => void
}

export default function ProgramStream({ brief, onProgramId }: Props) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const [attempt, setAttempt] = useState(0)
  // Exclusive tabs. Stay on the first arrived section (or the user's pick) —
  // never auto-advance as later SSE sections land.
  const [activeTab, setActiveTab] = useState<SectionKey | null>(null)

  useEffect(() => {
    setActiveTab(null)
  }, [attempt])

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    dispatch({ type: "reset" })

    async function run() {
      // Tracked locally and synchronously, not read back from React state —
      // the `state` this effect closed over is a snapshot from before any
      // dispatches happened, so it can never tell us what's actually arrived
      // by the time `done` shows up. This set is the completion watchdog's
      // source of truth: at `done`, any SECTION_ORDER key missing from it
      // means that frame was dropped somewhere (failed to parse, failed
      // schema validation, or never sent), and the user must see a named
      // error instead of a permanently-skeletoned card.
      const receivedKeys = new Set<SectionKey>()
      // True once a terminal dispatch (done-with-all-sections, or any error)
      // has fired. If the stream's connection closes without ever reaching
      // one, that is itself the same "permanent skeleton" failure the
      // watchdog exists to prevent, so it gets the same treatment below.
      let settled = false

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
                  if (parsed.success) {
                    receivedKeys.add("cohort")
                    dispatch({ type: "section", key: "cohort", payload: parsed.data })
                  } else {
                    logSectionValidationFailure("cohort", parsed.error, raw.payload)
                  }
                  break
                }
                case "placements": {
                  const parsed = z.array(PlacementSchema).safeParse(raw.payload)
                  if (parsed.success) {
                    receivedKeys.add("placements")
                    dispatch({ type: "section", key: "placements", payload: parsed.data })
                  } else {
                    logSectionValidationFailure("placements", parsed.error, raw.payload)
                  }
                  break
                }
                case "weeks": {
                  const parsed = CurriculumSchema.shape.weeks.safeParse(raw.payload)
                  if (parsed.success) {
                    receivedKeys.add("weeks")
                    dispatch({ type: "section", key: "weeks", payload: parsed.data })
                  } else {
                    logSectionValidationFailure("weeks", parsed.error, raw.payload)
                  }
                  break
                }
                case "cadence": {
                  const parsed = CurriculumSchema.shape.cadence.safeParse(raw.payload)
                  if (parsed.success) {
                    receivedKeys.add("cadence")
                    dispatch({ type: "section", key: "cadence", payload: parsed.data })
                  } else {
                    logSectionValidationFailure("cadence", parsed.error, raw.payload)
                  }
                  break
                }
                case "successCriteria": {
                  const parsed = CurriculumSchema.shape.successCriteria.safeParse(raw.payload)
                  if (parsed.success) {
                    receivedKeys.add("successCriteria")
                    dispatch({ type: "section", key: "successCriteria", payload: parsed.data })
                  } else {
                    logSectionValidationFailure("successCriteria", parsed.error, raw.payload)
                  }
                  break
                }
                case "kickoff": {
                  const parsed = CurriculumSchema.shape.kickoffMessage.safeParse(raw.payload)
                  if (parsed.success) {
                    receivedKeys.add("kickoff")
                    dispatch({ type: "section", key: "kickoff", payload: parsed.data })
                  } else {
                    logSectionValidationFailure("kickoff", parsed.error, raw.payload)
                  }
                  break
                }
                default:
                  logDroppedFrame(`"section" frame had an unrecognized key ("${String(raw.key)}")`, raw)
              }
            } else if (frame.event === "done") {
              // Completion watchdog: the server sending `done` only means IT
              // thinks generation finished — it says nothing about whether
              // every section survived the trip to this client intact. Gate
              // success on our own receipt record, not the server's say-so.
              const missing = SECTION_ORDER.filter(key => !receivedKeys.has(key))
              const data = frame.data as { programId?: string }
              if (missing.length > 0) {
                settled = true
                dispatch({
                  type: "error",
                  message:
                    `The program generator reported success, but ${missing.length === 1 ? "this section" : "these sections"} ` +
                    `never arrived intact: ${missing.join(", ")}. This is a lost or malformed update mid-stream, not a ` +
                    "generation failure — try again.",
                })
              } else if (!data.programId) {
                // Same failure class as a dropped section: every section
                // arrived, but without a program id the evidence panel can
                // never resolve a real placement row — loud failure over a
                // silently broken "View evidence" affordance.
                settled = true
                dispatch({
                  type: "error",
                  message: "The program generator reported success but never returned a program id. Try again.",
                })
              } else {
                settled = true
                dispatch({ type: "done", programId: data.programId })
                onProgramId(data.programId)
              }
            } else if (frame.event === "error") {
              settled = true
              const data = frame.data as { message?: string }
              dispatch({ type: "error", message: data.message ?? "The program generator returned an error." })
            }
          }
        }

        // The read loop above only exits when the connection closes. If it
        // closed without leftover unterminated bytes, `buffer` should be
        // empty — anything left means a frame arrived without its blank-line
        // terminator, which means something upstream (proxy, server pacing
        // change, truncated response) changed shape. Not fatal on its own
        // (the watchdog above already judged completeness), but worth a
        // loud warning since it's exactly the kind of thing that silently
        // grows into a dropped frame later.
        if (buffer.trim()) {
          console.warn("[ProgramStream] stream closed with an unterminated trailing frame in the buffer", buffer)
        }

        // Connection closed but no `done`, `error`, or watchdog dispatch ever
        // fired — the server hung up mid-stream. Same failure class as a
        // dropped frame: without this, the UI would sit on its last-arrived
        // skeleton forever with no signal that anything went wrong.
        if (!cancelled && !settled) {
          dispatch({
            type: "error",
            message: "The connection closed before the program finished streaming. Try again.",
          })
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

  const arrived = SECTION_ORDER.filter(key => state[key] !== undefined)
  const nextPending = SECTION_ORDER.find(key => state[key] === undefined) ?? null
  const programId = state.programId ?? null
  const firstArrived = arrived[0] ?? null

  // User pick wins when that section is ready; otherwise hold the first
  // arrived section. Only show the in-flight skeleton before anything lands.
  const displayTab: SectionKey | null =
    activeTab && state[activeTab] !== undefined
      ? activeTab
      : firstArrived ?? nextPending

  if (state.error) {
    return <ErrorCard message={state.error} onRetry={() => setAttempt(a => a + 1)} />
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--line)] bg-[var(--paper-raised)] px-4 py-3">
        <div className="min-w-0">
          <p className="font-display text-[13px] font-bold text-[var(--ink)]">
            {state.done ? "Program ready" : "Building your program"}
          </p>
          <p className="text-[12px] text-[var(--ink-faint)]">
            {state.done
              ? "All six parts are ready - browse the tabs anytime."
              : "Parts arrive in the background. Stay here, or open a tab when you want."}
          </p>
        </div>
        {state.done && programId ? (
          <Link
            href={`/program/${programId}`}
            className="btn-primary px-4 py-2 text-sm"
          >
            See the full program
          </Link>
        ) : null}
      </div>

      <div
        role="tablist"
        aria-label="Program sections"
        className="flex gap-1 overflow-x-auto border-b border-[var(--line)] pb-px"
      >
        {SECTION_ORDER.map(key => {
          const ready = state[key] !== undefined
          const selected = displayTab === key
          return (
            <button
              key={key}
              type="button"
              role="tab"
              id={`program-tab-${key}`}
              aria-selected={selected}
              aria-controls={`program-panel-${key}`}
              aria-disabled={!ready}
              onClick={() => {
                if (!ready) return
                setActiveTab(key)
              }}
              className={`relative shrink-0 px-3.5 py-2.5 text-sm font-semibold ${
                selected ? "text-[var(--accent)]" : "text-[var(--ink-soft)] hover:text-[var(--ink)]"
              }`}
            >
              {SECTION_LABEL[key]}
              {selected ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-[var(--accent)]"
                />
              ) : null}
            </button>
          )
        })}
      </div>

      <div
        role="tabpanel"
        id={displayTab ? `program-panel-${displayTab}` : undefined}
        aria-labelledby={displayTab ? `program-tab-${displayTab}` : undefined}
        className="min-h-[12rem]"
      >
        {displayTab && state[displayTab] !== undefined
          ? renderSectionCard(displayTab, state, programId)
          : displayTab && !state.done
            ? (
                <div className="rounded-3xl border border-[var(--line)] bg-[var(--paper-raised)] p-5 sm:p-7">
                  <SectionSkeleton kind={displayTab} />
                </div>
              )
            : null}
      </div>
    </div>
  )
}

function renderSectionCard(key: SectionKey, state: State, programId: string | null): ReactNode {
  switch (key) {
    case "cohort":
      return state.cohort && <CohortCard cohort={state.cohort} />
    case "placements":
      return state.placements && <PlacementsSection placements={state.placements} programId={programId} />
    case "weeks":
      return state.weeks && <WeeksSection weeks={state.weeks} />
    case "cadence":
      return state.cadence && <CadenceCard cadence={state.cadence} />
    case "successCriteria":
      return state.successCriteria && <SuccessCriteriaCard items={state.successCriteria} />
    case "kickoff":
      return state.kickoff && <KickoffCard kickoff={state.kickoff} />
    default: {
      // Exhaustiveness check tied directly to SECTION_ORDER: if a key is
      // ever added there without a case above, `key` is not `never` here and
      // this fails to compile — the mechanical guarantee the code review
      // asked for in place of a "keep these two in sync by hand" comment.
      const exhaustive: never = key
      return exhaustive
    }
  }
}

function SectionShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="animate-rise-in flex flex-col gap-5">
      <h2 className="font-display text-xl font-extrabold tracking-tight text-[var(--ink)] sm:text-2xl">
        {title}
      </h2>
      {children}
    </section>
  )
}

function CohortCard({ cohort }: { cohort: Cohort }) {
  const weekTicks = Math.max(1, Math.min(cohort.horizonWeeks, 16))

  return (
    <section className="animate-rise-in flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-12 lg:gap-5">
        <div className="flex min-h-[280px] flex-col justify-between rounded-[28px] border border-[var(--line)] bg-[var(--paper-raised)] p-6 sm:min-h-[340px] sm:p-8 lg:col-span-7">
          <div>
            <p className="font-display text-sm font-semibold text-[var(--accent)]">Who we&apos;re training</p>
            <p className="mt-4 font-display text-[1.65rem] font-semibold leading-[1.25] tracking-tight text-[var(--ink)] sm:text-[2.05rem]">
              {cohort.understanding}
            </p>
          </div>
          <div className="mt-10 border-t border-[var(--line)] pt-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-faint)]">
              Role
            </p>
            <p className="mt-1.5 max-w-xl text-base font-medium leading-snug text-[var(--ink-soft)]">
              {cohort.role}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 sm:gap-4 lg:col-span-5 lg:grid-cols-1 lg:grid-rows-3">
          <CohortMetric value={String(cohort.size)} label="learners" />
          <CohortMetric value={cohort.l1} label="primary L1" />
          <CohortMetric value={String(cohort.horizonWeeks)} label="week horizon" />
        </div>
      </div>

      <div className="overflow-hidden rounded-[28px] bg-[var(--navy)] px-6 py-6 text-white sm:px-8 sm:py-7">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45">
              Training window
            </p>
            <p className="mt-1.5 font-display text-xl font-extrabold tracking-tight sm:text-2xl">
              Ready in {cohort.horizonWeeks} weeks
            </p>
            <p className="mt-1 text-sm text-white/55">
              {cohort.size} learners · {cohort.l1}
            </p>
          </div>
          <div
            className="flex h-16 flex-1 items-end gap-1 sm:max-w-md sm:justify-end"
            aria-hidden="true"
          >
            {Array.from({ length: weekTicks }).map((_, i) => {
              const t = weekTicks === 1 ? 1 : i / (weekTicks - 1)
              return (
                <div
                  key={i}
                  className="min-w-[6px] flex-1 rounded-sm bg-[var(--accent)]"
                  style={{
                    height: `${28 + t * 36}%`,
                    opacity: 0.28 + t * 0.72,
                  }}
                />
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}

function CohortMetric({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex min-h-[100px] flex-col justify-end rounded-[24px] border border-[var(--line)] bg-[var(--paper-raised)] px-4 py-4 sm:min-h-[108px] sm:px-5 sm:py-5">
      <p className="font-display text-2xl font-extrabold tracking-tight text-[var(--ink)] sm:text-[1.85rem]">
        {value}
      </p>
      <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-faint)]">
        {label}
      </p>
    </div>
  )
}

function PlacementsSection({
  placements,
  programId,
}: {
  placements: PlacementCardData[]
  programId: string | null
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = placements.find(p => p.learnerId === selectedId) ?? null

  return (
    <SectionShell title={`Placements · ${placements.length} learners`}>
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

      {selected && programId && (
        <EvidencePanel
          key={selected.learnerId}
          programId={programId}
          learnerId={selected.learnerId}
          onClose={() => setSelectedId(null)}
        />
      )}

      {selected && !programId && (
        <div className="animate-rise-in rounded-2xl border border-[var(--accent)] bg-[var(--accent-soft)] p-4">
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
          <p className="mt-2 font-mono text-[10px] text-[var(--ink-faint)]">
            Full evidence (audio, phoneme-level agreement, override) unlocks once this program finishes generating.
          </p>
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
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [scenarioIdx, setScenarioIdx] = useState(0)
  const activeIdx = Math.min(selectedIdx, Math.max(weeks.length - 1, 0))
  const activeWeek = weeks[activeIdx] ?? null
  const scenarios = activeWeek?.scenarios ?? []
  const activeScenario = scenarios[Math.min(scenarioIdx, Math.max(scenarios.length - 1, 0))] ?? null

  return (
    <section className="animate-rise-in flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-display text-sm font-semibold text-[var(--accent)]">
            Curriculum · {weeks.length} weeks
          </p>
          <p className="mt-1 text-sm text-[var(--ink-faint)]">
            Pick a week, then open a scenario to see phrases and what success looks like.
          </p>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Curriculum weeks"
        className="flex gap-1.5 overflow-x-auto pb-0.5"
      >
        {weeks.map((w, i) => {
          const selected = activeIdx === i
          return (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => {
                setSelectedIdx(i)
                setScenarioIdx(0)
              }}
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl font-mono text-sm font-semibold transition-colors active:scale-[0.97] ${
                selected
                  ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                  : "border border-[var(--line)] bg-[var(--paper-raised)] text-[var(--ink-soft)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
              }`}
            >
              {w.n}
            </button>
          )
        })}
      </div>

      {activeWeek && (
        <div
          key={activeIdx}
          className="animate-rise-in grid gap-4 lg:grid-cols-12 lg:gap-5"
        >
          <div className="flex flex-col gap-4 lg:col-span-5">
            <div className="rounded-[28px] bg-[var(--navy)] px-6 py-6 text-white sm:px-7 sm:py-7">
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-white/45">
                Week {activeWeek.n}
              </p>
              <p className="mt-3 font-display text-[1.55rem] font-extrabold leading-snug tracking-tight sm:text-[1.75rem]">
                {activeWeek.theme}
              </p>
              <p className="mt-4 text-sm text-white/55">
                {scenarios.length} practice scenario{scenarios.length === 1 ? "" : "s"}
              </p>
            </div>

            <div className="flex flex-col gap-2" role="listbox" aria-label="Scenarios">
              {scenarios.map((s, i) => {
                const selected = Math.min(scenarioIdx, scenarios.length - 1) === i
                return (
                  <button
                    key={i}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => setScenarioIdx(i)}
                    className={`rounded-2xl border px-4 py-3.5 text-left transition-colors active:scale-[0.995] ${
                      selected
                        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                        : "border-[var(--line)] bg-[var(--paper-raised)] hover:border-[var(--ink-faint)]"
                    }`}
                  >
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--ink-faint)]">
                      Scenario {i + 1}
                    </p>
                    <p className="mt-1 text-sm font-semibold leading-snug text-[var(--ink)]">
                      {s.title}
                    </p>
                  </button>
                )
              })}
            </div>
          </div>

          {activeScenario && (
            <div className="flex min-h-[360px] flex-col justify-between rounded-[28px] border border-[var(--line)] bg-[var(--paper-raised)] p-6 sm:p-8 lg:col-span-7">
              <div>
                <p className="font-display text-sm font-semibold text-[var(--accent)]">
                  Scenario {Math.min(scenarioIdx, scenarios.length - 1) + 1}
                </p>
                <h3 className="mt-2 font-display text-2xl font-extrabold tracking-tight text-[var(--ink)] sm:text-[1.85rem]">
                  {activeScenario.title}
                </h3>
                <p className="mt-3 text-base leading-relaxed text-[var(--ink-soft)]">
                  {activeScenario.situation}
                </p>

                <div className="mt-7">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-faint)]">
                    Target phrases
                  </p>
                  <ul className="mt-3 flex flex-col gap-2">
                    {activeScenario.targetPhrases.map((phrase, j) => (
                      <li
                        key={j}
                        className="border-l-2 border-[var(--accent)] pl-3 text-[15px] font-medium leading-snug text-[var(--ink)]"
                      >
                        &ldquo;{phrase}&rdquo;
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="mt-8 rounded-2xl bg-[var(--accent-soft)] px-4 py-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--accent)]">
                  Success looks like
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-[var(--ink)]">
                  {activeScenario.successLooksLike}
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function CadenceCard({ cadence }: { cadence: Cadence }) {
  const weeklyMinutes = cadence.sessionsPerWeek * cadence.minutesPerSession

  return (
    <section className="animate-rise-in flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <CohortMetric value={String(cadence.sessionsPerWeek)} label="sessions / week" />
        <CohortMetric value={String(cadence.minutesPerSession)} label="minutes / session" />
        <CohortMetric value={String(weeklyMinutes)} label="minutes / week" />
      </div>
      <div className="rounded-[28px] border border-[var(--line)] bg-[var(--paper-raised)] px-6 py-6 sm:px-8">
        <p className="font-display text-sm font-semibold text-[var(--accent)]">Weekly rhythm</p>
        <p className="mt-3 max-w-2xl font-display text-2xl font-semibold tracking-tight leading-snug text-[var(--ink)]">
          {cadence.sessionsPerWeek} sessions a week, {cadence.minutesPerSession} minutes each -
          about {weeklyMinutes} minutes of speaking practice every week.
        </p>
      </div>
    </section>
  )
}

function SuccessCriteriaCard({ items }: { items: Criterion[] }) {
  return (
    <SectionShell title="Success criteria">
      <div className="flex flex-col divide-y divide-[var(--line)] overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--paper-raised)]">
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
    <SectionShell title="Kickoff message">
      <div className="flex items-center gap-1 self-start rounded-full border border-[var(--line)] bg-[var(--paper-raised)] p-1">
        {(["en", "ko"] as const).map(l => (
          <button
            key={l}
            type="button"
            aria-pressed={lang === l}
            onClick={() => setLang(l)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              lang === l ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "text-[var(--ink-soft)]"
            }`}
          >
            {l === "en" ? "EN" : "KO"}
          </button>
        ))}
      </div>
      <div className="rounded-2xl border border-[var(--line)] bg-[var(--paper-raised)] p-5">
        <p className="whitespace-pre-wrap font-display text-lg leading-relaxed text-[var(--ink)]">
          {kickoff[lang]}
        </p>
      </div>
    </SectionShell>
  )
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="animate-rise-in flex flex-col gap-3 rounded-2xl border border-[var(--band-c1)] bg-[var(--accent-soft)] p-5">
      <p className="font-display text-sm font-semibold text-[var(--band-c1)]">Generation failed</p>
      <p className="text-sm text-[var(--ink)]">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="self-start rounded-full bg-[var(--ink)] px-4 py-1.5 text-xs font-medium text-[var(--paper-raised)] transition-transform active:scale-[0.98]"
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
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 lg:grid-cols-12">
            <div className="skeleton-shimmer min-h-[280px] rounded-[28px] lg:col-span-7" />
            <div className="grid grid-cols-3 gap-3 lg:col-span-5 lg:grid-cols-1">
              <div className="skeleton-shimmer min-h-[100px] rounded-[24px]" />
              <div className="skeleton-shimmer min-h-[100px] rounded-[24px]" />
              <div className="skeleton-shimmer min-h-[100px] rounded-[24px]" />
            </div>
          </div>
          <div className="skeleton-shimmer h-28 rounded-[28px]" />
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
        <div className="flex flex-col gap-5">
          <div className="flex gap-1.5">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="skeleton-shimmer h-11 w-11 shrink-0 rounded-2xl" />
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-12">
            <div className="flex flex-col gap-3 lg:col-span-5">
              <div className="skeleton-shimmer h-40 rounded-[28px]" />
              <div className="skeleton-shimmer h-16 rounded-2xl" />
              <div className="skeleton-shimmer h-16 rounded-2xl" />
            </div>
            <div className="skeleton-shimmer min-h-[360px] rounded-[28px] lg:col-span-7" />
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
