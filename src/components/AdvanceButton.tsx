"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

// The build guide is explicit: this is a button, not a scheduler. Production
// would need a real weekly trigger (cron, queue, whatever the deployment
// target supports) — see the README. This is the manual stand-in for it.

type Props = {
  programId: string
  targetWeek: number
  /** Navigate to the newly-advanced week's brief on success, instead of just refreshing this page. */
  redirectToWeek?: boolean
  label?: string
}

export default function AdvanceButton({ programId, targetWeek, redirectToWeek, label }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleClick() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/programs/${programId}/advance`, { method: "POST" })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Advance failed (${res.status}).`)
      }
      if (redirectToWeek) {
        router.push(`/program/${programId}/week/${targetWeek}`)
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not advance the program.")
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className="btn-primary px-5 py-2.5 text-sm disabled:opacity-40"
      >
        {busy ? "Advancing…" : (label ?? `Advance to week ${targetWeek}`)}
      </button>
      {error && <p className="max-w-md text-[12px] text-[var(--band-c1)]">{error}</p>}
    </div>
  )
}
