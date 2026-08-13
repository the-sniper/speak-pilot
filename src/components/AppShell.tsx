import Link from "next/link"
import SpeakMark from "@/components/SpeakMark"

export default function AppShell() {
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--line)]/80 bg-[var(--paper-raised)]/90 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1100px] items-center justify-between gap-4 px-5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5 transition-opacity hover:opacity-80">
          <SpeakMark tone="accent" className="speak-wave" />
          <span className="font-display text-[15px] font-bold tracking-tight text-[var(--ink)]">
            Speak
            <span className="ml-1.5 font-medium text-[var(--ink-faint)]">Pilot</span>
          </span>
        </Link>

        <nav className="flex items-center gap-1 sm:gap-2">
          <Link
            href="/evals"
            className="rounded-full px-3 py-1.5 text-[13px] font-medium text-[var(--ink-soft)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--accent)]"
          >
            Evals
          </Link>
          <a
            href="https://www.speak.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full bg-[var(--ink)] px-3.5 py-1.5 text-[13px] font-semibold text-white transition-transform hover:-translate-y-px active:scale-[0.98]"
          >
            speak.com
          </a>
        </nav>
      </div>
    </header>
  )
}
