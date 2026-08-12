// Transcribed verbatim from docs/speak-pilot-build-guide.md, Appendix B —
// "Twenty briefs for the Evals tab. Deliberately varied in clarity, because
// real admins write badly."
//
// Numbers 16-20 are the adversarial set. Per the build guide: "A good system
// pushes back inside the output (a success criterion that says the timeline
// is unrealistic, or a program that reframes 'sound American' as
// intelligibility). Whatever it does, report it honestly in the eval
// table. How a system handles a bad brief is more revealing than how it
// handles a good one."
//
// `label` is what gets written into agent_runs.brief_label by
// scripts/run-evals.ts — every downstream eval query joins on this string,
// so it must never be edited without also updating any already-written rows.

export type EvalBriefCategory = "clear" | "vague" | "constrained" | "adversarial"

export type EvalBrief = {
  label: string
  category: EvalBriefCategory
  text: string
}

export const EVAL_BRIEFS: EvalBrief[] = [
  // Clear
  {
    label: "1",
    category: "clear",
    text: "18 people on our Seoul support team. They take escalation calls in English. Get them ready in 10 weeks.",
  },
  {
    label: "2",
    category: "clear",
    text: "12 warehouse supervisors in Osaka, need safety briefings and shift handovers in English, 8 weeks.",
  },
  {
    label: "3",
    category: "clear",
    text: "20 hotel front desk staff in Taipei, check-in and complaint handling, 12 weeks.",
  },
  {
    label: "4",
    category: "clear",
    text: "15 nurses, patient intake and family updates, 16 weeks.",
  },
  {
    label: "5",
    category: "clear",
    text: "9 sales engineers, technical demos and objection handling, 10 weeks.",
  },
  // Vague
  {
    label: "6",
    category: "vague",
    text: "Help my team get better at English before the Q3 offsite.",
  },
  {
    label: "7",
    category: "vague",
    text: "We need our engineers to run standups in English.",
  },
  {
    label: "8",
    category: "vague",
    text: "Customer service, 20 people, as fast as possible.",
  },
  {
    label: "9",
    category: "vague",
    text: "Make our Tokyo office more comfortable on client calls.",
  },
  {
    label: "10",
    category: "vague",
    text: "Onboarding for new hires who need business English.",
  },
  // Constrained or awkward
  {
    label: "11",
    category: "constrained",
    text: "6 people, 4 weeks, they present to the US board and are terrified.",
  },
  {
    label: "12",
    category: "constrained",
    text: "30 people, mixed levels, only 10 minutes a day available.",
  },
  {
    label: "13",
    category: "constrained",
    text: "Baseball clubhouse, Spanish and English both directions, spring training timeline.",
  },
  {
    label: "14",
    category: "constrained",
    text: "Night shift only, cannot attend live sessions, 12 weeks.",
  },
  {
    label: "15",
    category: "constrained",
    text: "Two teams merging, one Korean one Japanese, need a shared working language.",
  },
  // Adversarial
  {
    label: "16",
    category: "adversarial",
    text: "Everyone needs to be C1 by next month.",
  },
  {
    label: "17",
    category: "adversarial",
    text: "Just do whatever you did last time.",
  },
  {
    label: "18",
    category: "adversarial",
    text: "500 people.",
  },
  {
    label: "19",
    category: "adversarial",
    text: "They already speak English fine, this is a compliance checkbox.",
  },
  {
    label: "20",
    category: "adversarial",
    text: "Make them sound American.",
  },
]

export const ADVERSARIAL_BRIEF_LABELS: string[] =
  EVAL_BRIEFS.filter(b => b.category === "adversarial").map(b => b.label)
