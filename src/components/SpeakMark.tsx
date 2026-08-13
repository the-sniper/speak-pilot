// Speak's registered mark: four vertical bars of varying height (soundwave).
// Typographic wordmark sits beside it in AppShell / DemoBanner — not a
// fabricated logo beyond the publicly described trademark geometry.
type Props = {
  className?: string
  /** Ink color for the bars; defaults to currentColor */
  tone?: "ink" | "inverse" | "accent"
}

const TONE: Record<NonNullable<Props["tone"]>, string> = {
  ink: "var(--ink)",
  inverse: "#ffffff",
  accent: "var(--accent)",
}

export default function SpeakMark({ className, tone = "ink" }: Props) {
  const fill = TONE[tone]
  return (
    <svg
      width="22"
      height="18"
      viewBox="0 0 22 18"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <rect x="1" y="6" width="3.2" height="6" rx="1.6" fill={fill} />
      <rect x="6.6" y="2" width="3.2" height="14" rx="1.6" fill={fill} />
      <rect x="12.2" y="4.5" width="3.2" height="9" rx="1.6" fill={fill} />
      <rect x="17.8" y="7" width="3.2" height="4" rx="1.6" fill={fill} />
    </svg>
  )
}
