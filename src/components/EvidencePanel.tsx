"use client"

import { useEffect, useReducer, useState } from "react"
import { BANDS, type Band } from "@/lib/bands"
import type { PlacementEvidence, WordEvidence } from "@/lib/evidence"
import { BAND_BG, BAND_FG } from "./PlacementCard"

type Props = {
  programId: string
  learnerId: string
  onClose: () => void
}

// Fetch lifecycle + in-panel selection lives in a reducer (mirrors
// ProgramStream's own pattern) so the load effect below only ever calls
// `dispatch`, never a raw useState setter — the react-hooks/set-state-in-effect
// rule flags synchronous setState calls in an effect body, but not dispatch.
type PanelState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: PlacementEvidence; activeUttIdx: number; selectedWordIdx: number | null }

type PanelAction =
  | { type: "fetchStart" }
  | { type: "fetchError"; message: string }
  | { type: "fetchSuccess"; data: PlacementEvidence }
  | { type: "selectUtterance"; idx: number }
  | { type: "selectWord"; idx: number | null }
  | { type: "overrideSuccess"; band: Band }

function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "fetchStart":
      return { status: "loading" }
    case "fetchError":
      return { status: "error", message: action.message }
    case "fetchSuccess":
      return { status: "ready", data: action.data, activeUttIdx: 0, selectedWordIdx: null }
    case "selectUtterance":
      return state.status === "ready" ? { ...state, activeUttIdx: action.idx, selectedWordIdx: null } : state
    case "selectWord":
      return state.status === "ready" ? { ...state, selectedWordIdx: action.idx } : state
    case "overrideSuccess":
      // Mirrors only overriddenBand — exactly the field the PATCH route is
      // allowed to touch. `band`, the model's original word, is never part
      // of this action and never changes here.
      return state.status === "ready" ? { ...state, data: { ...state.data, overriddenBand: action.band } } : state
  }
}

// Single accent, graduated by intensity — the same visual law globals.css
// states for the band ramp ("a single terracotta accent graduated by
// intensity") extended here to phoneme/word correctness. Wrongness (low
// score) reads as more accent coverage; correctness fades toward paper. No
// second hue is introduced, so the "wrong phoneme" heat and the "high band"
// chip never compete for the same visual vocabulary.
const ACCENT_RGB = "184, 69, 31"

function heat(score: number, max: number): { background: string; light: boolean } {
  const wrongness = max > 0 ? 1 - score / max : 0
  const alpha = Math.min(0.92, 0.08 + wrongness * 0.82)
  return { background: `rgba(${ACCENT_RGB}, ${alpha})`, light: alpha > 0.48 }
}

function verdictLabel(v: number): string {
  return v === 2 ? "correct" : v === 1 ? "accented" : "wrong"
}

export default function EvidencePanel({ programId, learnerId, onClose }: Props) {
  const [state, dispatch] = useReducer(panelReducer, { status: "loading" } as PanelState)
  const [overrideBusy, setOverrideBusy] = useState(false)
  const [overrideError, setOverrideError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    dispatch({ type: "fetchStart" })

    fetch(`/api/placements?programId=${encodeURIComponent(programId)}&learnerId=${encodeURIComponent(learnerId)}`, {
      signal: controller.signal,
    })
      .then(async res => {
        if (!res.ok) throw new Error(`Evidence request failed (${res.status}).`)
        return (await res.json()) as PlacementEvidence
      })
      .then(evidence => dispatch({ type: "fetchSuccess", data: evidence }))
      .catch(err => {
        if (controller.signal.aborted) return
        dispatch({ type: "fetchError", message: err instanceof Error ? err.message : "Could not load evidence." })
      })

    return () => controller.abort()
  }, [programId, learnerId])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  // Lock background scroll while the drawer is open — otherwise a wheel
  // event over the backdrop scrolls the placement grid behind it instead of
  // the panel's own content, which reads as broken rather than a modal.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = prevOverflow
    }
  }, [])

  async function setOverride(band: Band) {
    if (state.status !== "ready" || overrideBusy) return
    setOverrideBusy(true)
    setOverrideError(null)
    try {
      const res = await fetch(`/api/placements/${state.data.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overriddenBand: band }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Override failed (${res.status}).`)
      }
      // The PATCH route updates overriddenBand only — the model's `band` is
      // never touched by it. `overrideSuccess` mirrors exactly that field.
      dispatch({ type: "overrideSuccess", band })
    } catch (err) {
      setOverrideError(err instanceof Error ? err.message : "Could not save the override.")
    } finally {
      setOverrideBusy(false)
    }
  }

  const loading = state.status === "loading"
  const loadError = state.status === "error" ? state.message : null
  const data = state.status === "ready" ? state.data : null
  const activeUttIdx = state.status === "ready" ? state.activeUttIdx : 0
  const selectedWordIdx = state.status === "ready" ? state.selectedWordIdx : null

  const activeUtt = data?.utterances[activeUttIdx] ?? null
  const activeWord: WordEvidence | null =
    activeUtt && selectedWordIdx !== null ? (activeUtt.words[selectedWordIdx] ?? null) : null

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close evidence panel"
        onClick={onClose}
        className="animate-scrim-in absolute inset-0 bg-[var(--ink)]/40 backdrop-blur-[2px]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Placement evidence for ${learnerId}`}
        data-evidence-panel={learnerId}
        className="animate-drawer-in relative flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-[var(--line)] bg-[var(--paper)] shadow-[-24px_0_60px_-24px_rgba(32,28,22,0.35)]"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-[var(--line)] bg-[var(--paper)]/95 px-6 py-5 backdrop-blur-sm">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
              Placement evidence
            </p>
            <p className="mt-1 font-mono text-sm text-[var(--ink)]">{learnerId}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full border border-[var(--line)] bg-[var(--paper-raised)] p-2 text-[var(--ink-soft)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-6 px-6 py-6">
          {loading && <PanelSkeleton />}

          {loadError && (
            <div className="rounded-xl border border-[var(--band-c1)] bg-[var(--accent-soft)] p-4 text-sm text-[var(--ink)]">
              {loadError}
            </div>
          )}

          {data && (
            <>
              {/* Band comparison — model's word is immutable, override sits beside it, never over it */}
              <section className="flex flex-col gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-raised)] p-4">
                <div className="flex flex-wrap items-center gap-4">
                  <BandReadout label="Model verdict" band={data.band} />
                  <span className="text-[var(--ink-faint)]">↔</span>
                  <BandReadout label="Human override" band={data.overriddenBand} muted={!data.overriddenBand} />
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {BANDS.map(b => {
                    const isCurrentOverride = data.overriddenBand === b
                    return (
                      <button
                        key={b}
                        type="button"
                        disabled={overrideBusy}
                        onClick={() => setOverride(b)}
                        aria-pressed={isCurrentOverride}
                        className={`rounded-md border px-2.5 py-1 font-mono text-[11px] font-medium transition-all disabled:opacity-50 ${
                          isCurrentOverride
                            ? "border-[var(--accent)] shadow-[0_0_0_1px_var(--accent)]"
                            : "border-[var(--line)] hover:border-[var(--accent)]"
                        }`}
                        style={{ background: BAND_BG[b], color: BAND_FG[b] }}
                      >
                        {b}
                      </button>
                    )
                  })}
                  {overrideBusy && (
                    <span className="font-mono text-[10px] text-[var(--ink-faint)]">saving…</span>
                  )}
                </div>
                {overrideError && <p className="text-[11px] text-[var(--band-c1)]">{overrideError}</p>}

                <p className="text-[11px] leading-relaxed text-[var(--ink-faint)]">
                  Bands are pronunciation-derived proxies from speechocean762 expert scores, not CEFR
                  assessments. The model&apos;s verdict is never edited — an override is stored alongside it.
                </p>
              </section>

              {/* Rationale */}
              <section>
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ink-faint)]">
                  Model&apos;s rationale
                </p>
                <blockquote className="mt-2 border-l-2 border-[var(--accent)] pl-4 font-display text-lg italic leading-snug text-[var(--ink)]">
                  &ldquo;{data.rationale}&rdquo;
                </blockquote>
              </section>

              {/* Utterance switcher */}
              {data.utterances.length > 0 && (
                <section className="flex flex-col gap-3">
                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ink-faint)]">
                    Cited evidence · {data.utterances.length} recording{data.utterances.length > 1 ? "s" : ""}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {data.utterances.map((u, i) => (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => dispatch({ type: "selectUtterance", idx: i })}
                        className={`rounded-md border px-2 py-1 font-mono text-[10px] transition-colors ${
                          i === activeUttIdx
                            ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--ink)]"
                            : "border-[var(--line)] bg-[var(--paper)] text-[var(--ink-soft)] hover:border-[var(--ink-faint)]"
                        }`}
                      >
                        {u.id}
                      </button>
                    ))}
                  </div>

                  {activeUtt && (
                    <UtteranceEvidenceBlock
                      key={activeUtt.id}
                      utterance={activeUtt}
                      selectedWordIdx={selectedWordIdx}
                      onSelectWord={idx => dispatch({ type: "selectWord", idx })}
                    />
                  )}
                </section>
              )}

              {activeWord && <PhonemeStrip word={activeWord} />}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function BandReadout({ label, band, muted }: { label: string; band: Band | null; muted?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--ink-faint)]">{label}</span>
      {band ? (
        <span
          className="w-fit rounded-md px-2.5 py-1 font-mono text-sm font-semibold"
          style={{ background: BAND_BG[band], color: BAND_FG[band] }}
        >
          {band}
        </span>
      ) : (
        <span
          className={`w-fit rounded-md border border-dashed border-[var(--ink-faint)] px-2.5 py-1 font-mono text-sm ${
            muted ? "text-[var(--ink-faint)]" : ""
          }`}
        >
          — none —
        </span>
      )}
    </div>
  )
}

function UtteranceEvidenceBlock({
  utterance,
  selectedWordIdx,
  onSelectWord,
}: {
  utterance: PlacementEvidence["utterances"][number]
  selectedWordIdx: number | null
  onSelectWord: (idx: number | null) => void
}) {
  const accuracies = utterance.expertScores.map(e => e.accuracy)
  const min = accuracies.length ? Math.min(...accuracies) : 0
  const max = accuracies.length ? Math.max(...accuracies) : 0

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-[var(--line)] bg-[var(--paper-raised)] p-4">
      <div className="flex flex-col gap-2">
        <audio controls src={utterance.audioPath} className="w-full" data-testid="evidence-audio" />
        <p className="font-display text-base italic leading-snug text-[var(--ink)]">
          &ldquo;{utterance.text}&rdquo;
        </p>
      </div>

      {accuracies.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--ink-faint)]">
            Expert spread · accuracy · {accuracies.length} raters
          </span>
          <div className="relative h-6 rounded-full bg-[var(--paper)]">
            <div
              className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--accent-soft)]"
              style={{ left: `${(min / 10) * 100}%`, width: `${((max - min) / 10) * 100}%` }}
            />
            {accuracies.map((a, i) => (
              <span
                key={i}
                title={`expert ${i}: ${a}/10`}
                className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--paper-raised)] bg-[var(--accent)]"
                style={{ left: `${(a / 10) * 100}%` }}
              />
            ))}
          </div>
          <span className="font-mono text-[10px] text-[var(--ink-faint)]">
            {min === max ? `all raters agreed: ${max}/10` : `range ${min}–${max} of 10`}
          </span>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--ink-faint)]">
          Words · click one for its phoneme-level agreement
        </span>
        <div className="flex flex-wrap gap-1.5">
          {utterance.words.map((w, i) => {
            const { background, light } = heat(w.accuracy, 10)
            const selected = i === selectedWordIdx
            return (
              <button
                key={i}
                type="button"
                onClick={() => onSelectWord(selected ? null : i)}
                className={`rounded-md px-2 py-1 font-mono text-[12px] transition-all ${
                  selected ? "shadow-[0_0_0_2px_var(--accent)]" : ""
                }`}
                style={{ background, color: light ? "var(--accent-ink)" : "var(--ink)" }}
                title={`accuracy ${w.accuracy}/10`}
              >
                {w.text}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function PhonemeStrip({ word }: { word: WordEvidence }) {
  return (
    <section className="animate-rise-in flex flex-col gap-3 rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] p-4">
      <div className="flex items-baseline justify-between">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
          Phoneme agreement · &ldquo;{word.text}&rdquo;
        </p>
        <p className="font-mono text-[10px] text-[var(--ink-soft)]">5 experts, verdicts 0=wrong 1=accented 2=correct</p>
      </div>

      <div className="flex flex-wrap items-start gap-3 overflow-x-auto pb-1">
        {word.phonemes.map((p, i) => {
          const { background, light } = heat(p.mean, 2)
          const split = p.disagreement > 0
          return (
            <div key={i} className="flex flex-col items-center gap-1.5">
              <div
                className={`flex min-w-9 flex-col items-center gap-0.5 rounded-lg px-2 py-1.5 ${
                  split ? "border-2 border-dashed border-[var(--ink)]" : "border border-transparent"
                }`}
                style={{ background, color: light ? "var(--accent-ink)" : "var(--ink)" }}
              >
                <span className="font-mono text-[13px] font-semibold">{p.phone}</span>
                <span className="font-mono text-[9px] opacity-80">{p.mean.toFixed(1)}</span>
              </div>

              {/* All five expert verdicts, never averaged away */}
              <div className="flex gap-0.5">
                {p.scores.map((s, j) => {
                  const tick = heat(s, 2)
                  return (
                    <span
                      key={j}
                      title={`expert ${j}: ${s} (${verdictLabel(s)})`}
                      className="flex size-4 items-center justify-center rounded-[3px] font-mono text-[8px] font-medium"
                      style={{ background: tick.background, color: tick.light ? "var(--accent-ink)" : "var(--ink)" }}
                    >
                      {s}
                    </span>
                  )
                })}
              </div>

              {split && (
                <span className="font-mono text-[9px] font-medium text-[var(--ink)]">
                  split · Δ{p.disagreement}
                </span>
              )}

              {p.insertionsAfter.length > 0 && (
                <div className="flex gap-1">
                  {p.insertionsAfter.map((ins, k) => (
                    <span
                      key={k}
                      title={`an expert heard an extra "${ins}" here — not in the reference`}
                      className="rounded-full border border-dashed border-[var(--accent)] px-1.5 py-0.5 font-mono text-[9px] italic text-[var(--accent)]"
                    >
                      +{ins}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <p className="font-mono text-[10px] leading-relaxed text-[var(--ink-soft)]">
        Dashed outline = experts disagreed on this phone (min–max span shown). Dashed pill = an expert heard a
        sound that isn&apos;t in the reference transcript at all.
      </p>
    </section>
  )
}

function PanelSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="skeleton-shimmer h-20 rounded-xl" />
      <div className="skeleton-shimmer h-14 rounded-xl" />
      <div className="skeleton-shimmer h-40 rounded-xl" />
    </div>
  )
}
