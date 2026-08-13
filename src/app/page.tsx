"use client"

import { useState } from "react"
import BriefBox from "@/components/BriefBox"
import ProgramStream from "@/components/ProgramStream"

export default function Home() {
  const [brief, setBrief] = useState<string | null>(null)
  const [programId, setProgramId] = useState<string | null>(null)

  return (
    <main className="flex flex-1 flex-col">
      {brief === null ? (
        <BriefBox onSubmit={setBrief} />
      ) : (
        <div className="flex flex-1 flex-col bg-[var(--paper)]">
          <div className="border-b border-[var(--line)] bg-[var(--paper-raised)]/80">
            <div className="mx-auto flex w-full max-w-[1100px] items-start justify-between gap-4 px-5 py-4 sm:px-8">
              <div className="min-w-0 flex-1">
                <p className="font-display text-[13px] font-semibold text-[var(--accent)]">
                  Building your program
                </p>
                <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--ink-soft)]">
                  {brief}
                </p>
                {programId ? (
                  <p className="mt-1 font-mono text-[11px] text-[var(--ink-faint)]">
                    id {programId.slice(0, 8)}…
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => {
                  setBrief(null)
                  setProgramId(null)
                }}
                className="shrink-0 rounded-full border border-[var(--line)] bg-[var(--paper)] px-4 py-2 text-[13px] font-semibold text-[var(--ink-soft)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                Start over
              </button>
            </div>
          </div>
          <div className="mx-auto w-full max-w-[1100px] flex-1 px-5 py-6 sm:px-8 sm:py-8">
            <ProgramStream brief={brief} onProgramId={setProgramId} />
          </div>
        </div>
      )}
    </main>
  )
}
