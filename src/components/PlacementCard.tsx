import type { CSSProperties } from "react"
import type { Band } from "@/lib/bands"

export type PlacementCardData = {
  learnerId: string
  band: Band
  rationale: string
  evidenceUtteranceIds: string[]
}

// Text color per band background — matches the terracotta ramp in
// globals.css. A1/A2/B1 sit on light fills (dark ink reads fine); B2/C1 are
// dark enough that ink text would fail contrast, so those two use the light
// accent ink instead (band-c1-ink is already defined for C1 in globals.css).
// Exported so ProgramStream's band legend and selected-placement detail
// strip use the exact same mapping instead of a second, driftable copy.
export const BAND_FG: Record<Band, string> = {
  A1: "var(--ink)",
  A2: "var(--ink)",
  B1: "var(--ink)",
  B2: "var(--accent-ink)",
  C1: "var(--band-c1-ink)",
}

export const BAND_BG: Record<Band, string> = {
  A1: "var(--band-a1)",
  A2: "var(--band-a2)",
  B1: "var(--band-b1)",
  B2: "var(--band-b2)",
  C1: "var(--band-c1)",
}

type Props = {
  placement: PlacementCardData
  selected?: boolean
  onSelect?: (learnerId: string) => void
  style?: CSSProperties
}

export default function PlacementCard({ placement, selected, onSelect, style }: Props) {
  return (
    <button
      type="button"
      data-placement-id={placement.learnerId}
      aria-pressed={selected}
      onClick={() => onSelect?.(placement.learnerId)}
      style={style}
      className={`animate-rise-in group flex flex-col gap-2 rounded-xl border bg-[var(--paper-raised)] p-3 text-left transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_20px_-12px_rgba(32,28,22,0.28)] ${
        selected
          ? "border-[var(--accent)] shadow-[0_10px_20px_-12px_rgba(184,69,31,0.4)]"
          : "border-[var(--line)]"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[11px] text-[var(--ink-soft)]">
          {placement.learnerId}
        </span>
        <span
          className="shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] font-medium"
          style={{ background: BAND_BG[placement.band], color: BAND_FG[placement.band] }}
        >
          {placement.band}
        </span>
      </div>
      <p className="line-clamp-2 text-[13px] leading-snug text-[var(--ink-soft)] group-hover:text-[var(--ink)]">
        {placement.rationale}
      </p>
    </button>
  )
}
