import { EVAL_BRIEFS } from "./eval-briefs"

// Human labels for the scenario-relevance judge (build guide Appendix A
// rubric, 0-3), one per brief in docs/eval-briefs.ts. This is the file the
// build guide means by "write your own labels for the same 20 scenarios" —
// the difference between running evals and performing them is reporting
// judge-vs-human AGREEMENT, not the judge's self-reported score alone.
//
// CRITICAL HONESTY NOTE, read before trusting this number for anything:
// "Human" is the wrong word for what these labels are. They were written by
// an LLM (the coding agent completing Task 15 — Claude, in an agentic coding
// session), not by a person. The build guide's intent was the repo author's
// independent judgment versus the LLM judge's; what actually exists here is
// one language model's judgment versus another language model's judgment.
// The agreement rate this produces (see src/lib/evals.ts's judgeAgreement,
// surfaced on /evals and in README.md) is an INTER-MODEL agreement rate, not
// independent human validation, and must never be presented or read as the
// latter. Labels from this repo's actual author, reading the real generated
// scenario text themselves, would be a meaningfully stronger check than what
// this file provides, and are the natural next step before trusting this
// number for anything beyond "the harness plumbing works end to end."
//
// PROCEDURE, so the ordering claim is checkable: these 19 scores (brief 9 has
// no real scenario to judge — see below) were formed by reading each brief's
// real generated first-scenario title + situation, pulled directly from
// agent_runs for sweep_id bdc8dd00-e60d-422d-b213-a728865eea1e (the real
// LLM_PROVIDER=openai / gpt-5 sweep, Task 15) via:
//
//   select brief_label, output->'weeks'->0->'scenarios'->0->>'title',
//          output->'weeks'->0->'scenarios'->0->>'situation'
//   from agent_runs
//   where sweep_id = 'bdc8dd00-e60d-422d-b213-a728865eea1e'
//     and kind = 'curriculum' and ok = true
//   order by brief_label::int;
//
// against the Appendix A rubric:
//   0 generic, could apply to any role
//   1 loosely related to the role's domain
//   2 clearly relevant to the role
//   3 specific to a real situation this role faces, with the right register
//
// scored and written into this file BEFORE the judge's own scores for these
// 20 briefs were queried or viewed. Only after every label below was final
// was `select brief_label, output->>'score' from agent_runs where
// sweep_id = '...' and kind = 'judge'` run, to compute agreement — see
// src/lib/evals.ts's loadEvalsSummary / the Evals tab for that number.
//
// Brief 9 ("Make our Tokyo office more comfortable on client calls") failed
// with a transport error ("fetch failed") before its curriculum call ever
// completed — no scenario was ever generated for it, so there is genuinely
// nothing to label. Its value stays `null`, the same honest "not labeled" the
// whole file used before this sweep — it is not a 0, and it is excluded from
// the agreement calculation the same way an unlabeled brief always was.
export const HUMAN_SCENARIO_RELEVANCE_LABELS: Record<string, number | null> = {
  "1": 3,   // "Rebuilding trust after three transfers" — escalation support, concrete and on-register
  "2": 3,   // "Kickoff handover... WMS dashboard" — warehouse-specific, matches "shift handovers" exactly
  "3": 3,   // "Peak-hour check-in with a queue" — concrete hotel front-desk situation
  "4": 3,   // "Confirm identity in a busy ED triage bay" — concrete nurse/patient-intake situation
  "5": 2,   // "Kickoff... 5 mixed stakeholders" — relevant to sales engineers, but opening logistics, not yet the demo/objection-handling substance the brief named
  "6": 3,   // "Rushed discovery with a late-joining VP" — concrete, plausible AE discovery-call scenario
  "7": 3,   // "Kick off and frame the sprint goal" — Scrum-register-accurate, matches "run standups" exactly
  "8": 3,   // "De-escalating... about a double charge" — concrete, specific complaint type
  "9": null, // curriculum generation failed for this brief (transport error) — no real scenario exists to label
  "10": 2,  // "Introduce yourself in a cross-functional meeting" — on-topic for new-hire onboarding, but a fairly generic self-intro task
  "11": 3,  // "Open the board presentation in 60 seconds (BLUF)" — concrete, matches "terrified," "4 weeks" urgency
  "12": 2,  // "Open a call after a long wait" — plausible support scenario, but a fairly generic queue-wait opener
  "13": 3,  // "Check-in... 40-man vs. NRI... bilingual clubhouse" — genuinely distinctive baseball-specific register
  "14": 3,  // "De-escalating... at 2 a.m." — ties directly to the "night shift only" constraint
  "15": 3,  // "Set working agreements for mixed-language meetings" — ties directly to the merger brief
  "16": 3,  // "De-escalate a customer... (phone)" — solid, on-topic escalation scenario despite the adversarial brief
  "17": 2,  // "Phone greeting and security verification" — on-topic but a fairly standard/generic support-call opener
  "18": 2,  // "Professional opening and identity verification" — same reasoning as 17
  "19": 3,  // "Confirming Code of Conduct acknowledgment" — a genuinely sharp, concrete reframing of the "compliance checkbox" brief
  "20": 2,  // "Open the call like a US rep... in 20 seconds" — on-topic but a fairly generic call-opening task
} satisfies Record<(typeof EVAL_BRIEFS)[number]["label"], number | null>
