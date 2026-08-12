export const HONESTY_TEXT =
  "Northwind Support and its people are fictional. Every recording, score, and expert " +
  "annotation is real human-annotated learner speech from speechocean762 (CC BY 4.0). " +
  "The week-over-week trajectory is constructed — the dataset captures one session per " +
  "speaker, so progress over time is simulated by ordering real utterances. Placement " +
  "accuracy is measured against real expert consensus and is not simulated."

export default function HonestyBanner() {
  return (
    <div className="border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-[11px] leading-relaxed text-neutral-600">
      {HONESTY_TEXT}
    </div>
  )
}
