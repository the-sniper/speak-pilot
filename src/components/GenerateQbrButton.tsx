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
        className={
          hasExisting
            ? "rounded-full border border-[var(--line)] px-5 py-2.5 text-sm font-semibold text-[var(--ink-soft)] transition-colors hover:enabled:border-[var(--accent)] hover:enabled:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
            : "btn-primary px-5 py-2.5 text-sm disabled:opacity-40"
        }
      >
        {busy ? "Generating…" : hasExisting ? "Regenerate QBR" : "Generate QBR"}
      </button>
      {error && <p className="max-w-md text-[12px] text-[var(--band-c1)]">{error}</p>}
    </div>
  )
}
