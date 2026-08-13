"use client"

import { useRef, useState } from "react"
import { motion, useReducedMotion } from "motion/react"
import DemoHonesty from "@/components/DemoHonesty"
import SpeakMark from "@/components/SpeakMark"

const PLACEHOLDER =
  "18 people on our Seoul support team. They take escalation calls in English. Get them ready in 10 weeks."

const EXAMPLES = [
  {
    label: "Seoul support desk",
    hint: "escalation calls",
    brief: PLACEHOLDER,
  },
  {
    label: "Baseball clubhouse",
    hint: "press interviews",
    brief:
      "12 players and coaches moving from the KBO to a US farm team. They handle post-game " +
      "press interviews and clubhouse interviews in English. Get them ready in 8 weeks.",
  },
  {
    label: "Plant supervisors",
    hint: "safety briefings",
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
  const [activeExample, setActiveExample] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const reduce = useReducedMotion()

  const submit = () => {
    const brief = value.trim()
    if (!brief) return
    onSubmit(brief)
  }

  const fillExample = (label: string, brief: string) => {
    setActiveExample(label)
    setValue(brief)
    textareaRef.current?.focus()
  }

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_0%_0%,rgb(28_73_255/0.09),transparent_42%),radial-gradient(ellipse_at_100%_20%,rgb(139_97_253/0.07),transparent_40%),radial-gradient(ellipse_at_50%_100%,rgb(233_255_107/0.12),transparent_45%)]"
      />

      <div className="relative z-10 mx-auto flex w-full max-w-[720px] flex-1 flex-col justify-center px-5 py-12 sm:px-8 sm:py-16">
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-col gap-8"
        >
          <div className="flex flex-col gap-4">
            <div className="inline-flex items-center gap-2 text-[var(--ink-soft)]">
              <SpeakMark tone="accent" className="speak-wave" />
              <span className="font-display text-[13px] font-semibold tracking-tight">
                Speak Pilot
              </span>
            </div>

            <h1 className="font-display text-[2.15rem] font-extrabold leading-[1.12] tracking-tight text-[var(--ink)] sm:text-[2.75rem]">
              Who needs to get speaking?
            </h1>
            <p className="max-w-[42ch] text-[15px] leading-relaxed text-[var(--ink-soft)] sm:text-base">
              Jot a line about the team - role, pressure, and how many weeks you have.
              We&apos;ll place them, build the curriculum, and draft the coaching notes.
            </p>
          </div>

          <div className="overflow-hidden rounded-[1.35rem] border border-[var(--line)] bg-[var(--paper-raised)] shadow-[0_20px_50px_-34px_rgb(18_32_90/0.28)] focus-within:border-[var(--accent)] focus-within:shadow-[0_22px_55px_-30px_rgb(28_73_255/0.38)]">
            <label htmlFor="team-brief" className="sr-only">
              Team brief
            </label>
            <textarea
              id="team-brief"
              ref={textareaRef}
              value={value}
              onChange={e => {
                setValue(e.target.value)
                setActiveExample(null)
              }}
              onKeyDown={e => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder={PLACEHOLDER}
              rows={4}
              className="w-full resize-none bg-transparent px-5 py-5 text-[15px] leading-relaxed text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:outline-none sm:px-6 sm:text-base"
            />
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] px-4 py-3 sm:px-5">
              <p className="text-[12px] text-[var(--ink-faint)]">
                Tip: keep it casual. One or two sentences is plenty.
              </p>
              <button
                type="button"
                onClick={submit}
                disabled={!value.trim()}
                className="btn-primary px-5 py-2.5 text-sm"
              >
                Build the program
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-[var(--ink-faint)]">Or start from one of these</p>
            <div className="flex flex-col gap-1.5">
              {EXAMPLES.map(ex => {
                const active = activeExample === ex.label
                return (
                  <button
                    key={ex.label}
                    type="button"
                    onClick={() => fillExample(ex.label, ex.brief)}
                    className={`group flex items-center justify-between gap-3 rounded-xl px-3.5 py-3 text-left transition-colors active:scale-[0.995] ${
                      active
                        ? "bg-[var(--accent-soft)]"
                        : "hover:bg-[var(--paper-raised)]"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="font-display text-[14px] font-bold text-[var(--ink)]">
                        {ex.label}
                      </span>
                      <span className="mt-0.5 block text-[12px] text-[var(--ink-faint)]">
                        {ex.hint}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 text-[12px] font-semibold ${
                        active ? "text-[var(--accent)]" : "text-[var(--ink-faint)] group-hover:text-[var(--accent)]"
                      }`}
                    >
                      Use this
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          <DemoHonesty />
        </motion.div>
      </div>
    </div>
  )
}
