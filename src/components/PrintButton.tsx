"use client"

// window.print() is the QBR's export path, in full — no PDF pipeline sits
// behind this button, and the README says so plainly. `print:hidden` keeps
// this control (and the row it sits in) out of the printed output itself.

export default function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-full border border-[var(--line)] px-5 py-2 text-sm font-medium text-[var(--ink-soft)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] print:hidden"
    >
      Print / save as PDF
    </button>
  )
}
