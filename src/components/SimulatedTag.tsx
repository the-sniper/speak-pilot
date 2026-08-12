// Standing project constraint: the seeded dataset holds one real session per
// speaker, no time dimension. Every week-over-week trajectory or
// score-movement number is CONSTRUCTED — built by ordering real utterances
// into a sequence of weeks, not measured over calendar time. The honesty
// banner (src/components/HonestyBanner.tsx) discloses this globally, once,
// at the top of the app; this tag repeats the disclosure locally, at every
// individual point where that construction is being presented as if it were
// a trend, so a manager skimming one number in isolation still sees it.
export const SIMULATED_TOOLTIP =
  "Constructed, not measured over time: the dataset has one real session per speaker. " +
  "This figure is built by ordering real utterances into a week-over-week sequence."

type Props = {
  className?: string
  label?: string
}

export default function SimulatedTag({ className, label = "simulated" }: Props) {
  return (
    <span
      title={SIMULATED_TOOLTIP}
      data-simulated-tag=""
      className={`inline-flex shrink-0 cursor-help items-center gap-1 rounded-full border border-dashed border-[var(--ink-faint)] px-1.5 py-0.5 align-middle font-mono text-[9px] font-medium uppercase leading-none tracking-wide text-[var(--ink-faint)] ${className ?? ""}`}
    >
      <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true">
        <path
          d="M0.5 4.5C1.4 2 2.3 7 3.2 4.5C4.1 2 5 7 5.9 4.5C6.8 2 7.7 4.5 8.5 4.5"
          stroke="currentColor"
          strokeWidth="0.9"
          strokeLinecap="round"
        />
      </svg>
      {label}
    </span>
  )
}
