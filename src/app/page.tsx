"use client"

import { useState } from "react"
import BriefBox from "@/components/BriefBox"
import ProgramStream from "@/components/ProgramStream"

export default function Home() {
  const [brief, setBrief] = useState<string | null>(null)
  // Not yet consumed elsewhere on this screen — Task 10's evidence panel is
  // the first thing that will need it. Captured here so ProgramStream's
  // onProgramId contract has a real destination from day one.
  const [, setProgramId] = useState<string | null>(null)

  return (
    <main className="flex flex-1 flex-col items-center">
      {brief === null ? (
        <div className="flex flex-1 items-center justify-center">
          <BriefBox onSubmit={setBrief} />
        </div>
      ) : (
        <div className="w-full max-w-5xl px-6 py-10">
          <div className="mb-10 flex items-start justify-between gap-4 border-b border-[var(--line)] pb-4">
            <p className="max-w-2xl text-sm leading-relaxed text-[var(--ink-soft)]">{brief}</p>
            <button
              type="button"
              onClick={() => {
                setBrief(null)
                setProgramId(null)
              }}
              className="shrink-0 whitespace-nowrap font-mono text-[11px] uppercase tracking-wide text-[var(--ink-faint)] transition-colors hover:text-[var(--accent)]"
            >
              New program
            </button>
          </div>
          <ProgramStream brief={brief} onProgramId={setProgramId} />
        </div>
      )}
    </main>
  )
}
