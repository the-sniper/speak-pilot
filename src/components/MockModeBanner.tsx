import { isMockProviderActive } from "@/lib/llm/adapter"

// Repo owner filed this as a usability/honesty defect: with LLM_PROVIDER=mock,
// the generation screen, program page, week page, and QBR page rendered
// placeholder strings (e.g. "mock-understanding-1uuu5ak") with nothing on
// screen explaining what they were. /evals already solves this correctly —
// a ProvenanceBanner plus per-metric MockBadge, both driven by one `isMock`
// boolean computed server-side. This component follows that same pattern for
// the other four screens: one server-side boolean gates one disclosure.
//
// Two differences from /evals's version, both deliberate:
//   1. /evals's `isMock` describes a STORED SWEEP's provider (read from that
//      sweep's own agent_runs rows) because the claim there is about old
//      data someone else may have produced. Here the claim is about the
//      content on screen RIGHT NOW, so the source has to be the server's
//      currently active provider (`isMockProviderActive()`, resolved from
//      LLM_PROVIDER exactly like adapter.ts's real resolveProvider()) — never
//      a client-side env var, which would read as `undefined` in the browser
//      and silently mislabel real output as mock or vice versa.
//   2. /evals's own history is why this isn't a single in-flow banner at the
//      top of the page: code review fix round 1 on Task 13 found that an
//      in-flow banner scrolls out of view by the time a reader reaches the
//      numbers it disclaims, so a cropped screenshot of just the content
//      looks like a real measurement. This banner is `position: fixed` to
//      the viewport instead, so it is on screen without scrolling and stays
//      there — including in a screenshot cropped to the main content area —
//      no matter how far the page scrolls.
export const MOCK_MODE_TEXT =
  "Mock mode — this is placeholder output from the built-in mock provider, not model output. " +
  "The real cached responses are served with LLM_PROVIDER=openai LLM_API_KEY= REPLAY=1 npm run dev."

export default function MockModeBanner() {
  if (!isMockProviderActive()) return null

  return (
    <div
      data-mock-mode-banner=""
      role="status"
      className="fixed inset-x-0 bottom-0 z-50 border-t-2 border-dashed border-[var(--accent)] bg-[var(--accent-soft)] px-4 py-2.5 text-center"
    >
      <p className="mx-auto max-w-3xl font-mono text-[11px] leading-relaxed text-[var(--ink)]">
        <strong className="font-semibold uppercase tracking-wide text-[var(--accent)]">Mock mode —</strong>{" "}
        this is placeholder output from the built-in mock provider, not model output. The real cached
        responses are served with{" "}
        <code className="rounded bg-[var(--paper)] px-1 py-0.5 text-[10px]">
          LLM_PROVIDER=openai LLM_API_KEY= REPLAY=1 npm run dev
        </code>
        .
      </p>
    </div>
  )
}
