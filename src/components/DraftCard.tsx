"use client"

import { useState } from "react"
import type { DraftView } from "@/lib/program-view"

// NEVER auto-send, never a state implying a message left the building. This
// component has exactly two mutations available — save an edit, flip status
// to "approved" — and nothing else. There is no "Send" affordance anywhere
// below, by construction: no button, no icon, no copy that reads as an
// envelope leaving. Approve is a quiet, local confirmation, not a dispatch.

type Props = {
  draft: DraftView
}

const CHANNEL_LABEL: Record<DraftView["channel"], string> = { email: "Email", slack: "Slack DM" }

export default function DraftCard({ draft: initial }: Props) {
  const [draft, setDraft] = useState(initial)
  const [editing, setEditing] = useState(false)
  const [draftText, setDraftText] = useState(initial.editedBody ?? initial.body)
  const [showOriginal, setShowOriginal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [approving, setApproving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justApproved, setJustApproved] = useState(false)

  const effectiveBody = draft.editedBody ?? draft.body
  const wasEdited = draft.editedBody !== null

  async function patch(payload: { editedBody?: string; status?: "draft" | "approved" }) {
    const res = await fetch(`/api/drafts/${draft.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error ?? `Request failed (${res.status}).`)
    }
    return res.json()
  }

  async function saveEdit() {
    setSaving(true)
    setError(null)
    try {
      await patch({ editedBody: draftText })
      setDraft(d => ({ ...d, editedBody: draftText }))
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this edit.")
    } finally {
      setSaving(false)
    }
  }

  async function approve() {
    setApproving(true)
    setError(null)
    try {
      await patch({ status: "approved" })
      setDraft(d => ({ ...d, status: "approved" }))
      setJustApproved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve this draft.")
    } finally {
      setApproving(false)
    }
  }

  return (
    <div
      data-draft-id={draft.id}
      data-draft-status={draft.status}
      className="animate-rise-in flex flex-col gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-raised)] p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-[var(--ink)]">
            {draft.learner.name ?? draft.learnerId}
            {draft.learner.role && (
              <span className="ml-1.5 font-normal text-[var(--ink-faint)]">· {draft.learner.role}</span>
            )}
          </span>
          <span className="font-mono text-[11px] text-[var(--ink-faint)]">{CHANNEL_LABEL[draft.channel]}</span>
        </div>

        <span
          className={`rounded-md px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide ${
            draft.status === "approved"
              ? "bg-[var(--accent-soft)] text-[var(--accent)]"
              : "border border-[var(--line)] text-[var(--ink-faint)]"
          }`}
        >
          {draft.status}
        </span>
      </div>

      <p className="rounded-lg border border-dashed border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-[12px] leading-relaxed text-[var(--ink-soft)]">
        <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--ink-faint)]">Why this draft — </span>
        {draft.reason}
      </p>

      {draft.subject && (
        <p className="text-sm font-medium text-[var(--ink)]">{draft.subject}</p>
      )}

      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={draftText}
            onChange={e => setDraftText(e.target.value)}
            rows={6}
            className="w-full resize-y rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm leading-relaxed text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={saveEdit}
              disabled={saving || !draftText.trim()}
              className="rounded-full bg-[var(--ink)] px-4 py-1.5 text-xs font-medium text-[var(--paper)] transition-opacity disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save edit"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraftText(effectiveBody)
                setEditing(false)
                setError(null)
              }}
              disabled={saving}
              className="rounded-full border border-[var(--line)] px-4 py-1.5 text-xs text-[var(--ink-soft)]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--ink)]">{effectiveBody}</p>
      )}

      {/* Editing must never destroy the model's original — body stays
          immutable server-side (see PATCH /api/drafts/[id]) and this toggle
          is what makes that recoverable in the UI, exactly like
          placements.band vs overriddenBand in EvidencePanel. */}
      {wasEdited && !editing && (
        <div className="flex flex-col gap-1.5 border-t border-dashed border-[var(--line)] pt-2.5">
          <button
            type="button"
            onClick={() => setShowOriginal(s => !s)}
            className="w-fit font-mono text-[10px] uppercase tracking-wide text-[var(--ink-faint)] underline decoration-dotted underline-offset-2 hover:text-[var(--accent)]"
          >
            Edited by a human — {showOriginal ? "hide" : "show"} the model&apos;s original
          </button>
          {showOriginal && (
            <p className="whitespace-pre-wrap rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-[12px] italic leading-relaxed text-[var(--ink-faint)]">
              {draft.body}
            </p>
          )}
        </div>
      )}

      {error && <p className="text-[11px] text-[var(--band-c1)]">{error}</p>}

      {!editing && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setDraftText(effectiveBody)
              setEditing(true)
              setError(null)
            }}
            className="rounded-full border border-[var(--line)] px-4 py-1.5 text-xs text-[var(--ink-soft)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            Edit
          </button>

          {draft.status === "approved" ? (
            // Quiet confirmation, not a "Sent" state — approving only
            // records that a human signed off; nothing here implies the
            // message left the building.
            <span className="font-mono text-[11px] text-[var(--accent)]" data-testid="approve-confirmation">
              {justApproved ? "✓ Approved just now" : "✓ Approved"}
            </span>
          ) : (
            <button
              type="button"
              onClick={approve}
              disabled={approving}
              className="rounded-full bg-[var(--accent)] px-4 py-1.5 text-xs font-medium text-[var(--accent-ink)] transition-opacity disabled:opacity-40"
            >
              {approving ? "Approving…" : "Approve"}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
