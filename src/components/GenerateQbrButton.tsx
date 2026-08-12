"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

// Same shape as AdvanceButton: a manual stand-in for what would run on a
// schedule (or on-demand from a manager's dashboard) in production. One
// `POST /api/programs/[id]/qbr` call, then refresh to read back the
// persisted result — the QBR is never regenerated on page load, only on an
// explicit click here.

type Props = {
  programId: string
  /** Present once a QBR already exists — swaps the label to "Regenerate" and softens the tone. */
  hasExisting?: boolean
}

export default function GenerateQbrButton({ programId, hasExisting }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleClick() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/programs/${programId}/qbr`, { method: "POST" })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `QBR generation failed (${res.status}).`)
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate the QBR.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-start gap-2 print:hidden">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className={`rounded-full px-5 py-2 text-sm font-medium transition-transform disabled:cursor-not-allowed disabled:opacity-40 ${
          hasExisting
            ? "border border-[var(--line)] text-[var(--ink-soft)] hover:enabled:border-[var(--accent)] hover:enabled:text-[var(--accent)]"
            : "bg-[var(--accent)] text-[var(--accent-ink)] hover:enabled:-translate-y-px hover:enabled:shadow-[0_6px_16px_-6px_rgba(184,69,31,0.55)]"
        }`}
      >
        {busy ? "Generating…" : hasExisting ? "Regenerate QBR" : "Generate QBR"}
      </button>
      {error && <p className="max-w-md text-[12px] text-[var(--band-c1)]">{error}</p>}
    </div>
  )
}
