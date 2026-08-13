export const HONESTY_TEXT =
  "Northwind Support and its people are fictional. Every recording, score, and expert " +
  "annotation is real human-annotated learner speech from speechocean762 (CC BY 4.0). " +
  "The week-over-week trajectory is constructed - the dataset captures one session per " +
  "speaker, so progress over time is simulated by ordering real utterances. Placement " +
  "accuracy is measured against real expert consensus and is not simulated."

type Props = {
  className?: string
}

export default function DemoHonesty({ className }: Props) {
  return (
    <details
      className={`group max-w-md text-left ${className ?? ""}`}
      data-demo-honesty=""
    >
      <summary className="cursor-pointer list-none text-[12px] font-medium text-[var(--ink-faint)] transition-colors hover:text-[var(--accent)] [&::-webkit-details-marker]:hidden">
        <span className="underline decoration-dotted underline-offset-2">About this demo</span>
      </summary>
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--ink-soft)]">{HONESTY_TEXT}</p>
    </details>
  )
}
