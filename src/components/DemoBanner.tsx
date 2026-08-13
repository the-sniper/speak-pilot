export const DEMO_BANNER_TEXT =
  "Made for Speak - a concept demo, not a shipped product. Speak Pilot."

export default function DemoBanner() {
  return (
    <div className="bg-[var(--ink)] px-4 py-2 text-center sm:text-left">
      <p className="mx-auto flex max-w-[1100px] flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[12px] leading-relaxed text-white/75 sm:justify-between sm:px-4">
        <span>
          Made for{" "}
          <a
            href="https://www.speak.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="font-display font-semibold text-[var(--lime)] underline decoration-[var(--lime)]/40 underline-offset-2 transition-colors hover:decoration-[var(--lime)]"
          >
            Speak
          </a>
          {" "}
          - a concept demo, not a shipped product.
        </span>
        <span className="hidden text-white/40 sm:inline">Speak Pilot</span>
      </p>
    </div>
  )
}
