"use client"

import { useRef, useState } from "react"

const PLACEHOLDER =
  "18 people on our Seoul support team. They take escalation calls in English. Get them ready in 10 weeks."

// Three example chips per the build guide: Seoul is the canonical demo
// brief (used verbatim as the placeholder above too), the other two exist to
// show the tool isn't a one-trick demo. All three are just prompt text —
// nothing here is presented as real cohort data.
const EXAMPLES = [
  {
    label: "Seoul support team",
    brief: PLACEHOLDER,
  },
  {
    label: "Baseball clubhouse",
    brief:
      "12 players and coaches moving from the KBO to a US farm team. They handle post-game " +
      "press interviews and clubhouse interviews in English. Get them ready in 8 weeks.",
  },
  {
    label: "Manufacturing floor",
    brief:
      "30 line supervisors at our Ulsan plant. They run safety briefings and walk English-speaking " +
      "auditors through the floor. Get them ready in 6 weeks.",
  },
] as const

type Props = {
  onSubmit: (brief: string) => void
}

export default function BriefBox({ onSubmit }: Props) {
  const [value, setValue] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const submit = () => {
    const brief = value.trim()
    if (!brief) return
    onSubmit(brief)
  }

  const fillExample = (brief: string) => {
    setValue(brief)
    textareaRef.current?.focus()
  }

  return (
    <div className="flex w-full max-w-xl flex-col items-center gap-6 px-6">
      <p className="font-display text-2xl italic text-[var(--ink)] sm:text-3xl">
        Describe the team.
      </p>

      <div className="w-full">
        <div className="relative rounded-2xl border border-[var(--line)] bg-[var(--paper-raised)] shadow-[0_1px_2px_rgba(32,28,22,0.04),0_12px_28px_-14px_rgba(32,28,22,0.18)] transition-shadow focus-within:border-[var(--accent)] focus-within:shadow-[0_1px_2px_rgba(32,28,22,0.04),0_16px_32px_-12px_rgba(184,69,31,0.28)]">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={PLACEHOLDER}
            rows={3}
            className="w-full resize-none bg-transparent px-6 py-5 text-lg leading-relaxed text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:outline-none"
          />
          <div className="flex items-center justify-between gap-3 border-t border-[var(--line)] px-6 py-3">
            <span className="font-mono text-[11px] tracking-wide text-[var(--ink-faint)]">
              ⌘⏎ to generate
            </span>
            <button
              type="button"
              onClick={submit}
              disabled={!value.trim()}
              className="rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-medium text-[var(--accent-ink)] transition-transform hover:enabled:-translate-y-px hover:enabled:shadow-[0_6px_16px_-6px_rgba(184,69,31,0.55)] disabled:cursor-not-allowed disabled:opacity-30"
            >
              Generate program →
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        {EXAMPLES.map(ex => (
          <button
            key={ex.label}
            type="button"
            onClick={() => fillExample(ex.brief)}
            className="rounded-full border border-[var(--line)] bg-[var(--paper-raised)] px-4 py-1.5 text-xs text-[var(--ink-soft)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            {ex.label}
          </button>
        ))}
      </div>
    </div>
  )
}
