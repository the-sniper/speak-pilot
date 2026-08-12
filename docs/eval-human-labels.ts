import { EVAL_BRIEFS } from "./eval-briefs"

// Human labels for the scenario-relevance judge (build guide Appendix A
// rubric, 0-3), one per brief in docs/eval-briefs.ts. This is the file the
// build guide means by "write your own labels for the same 20 scenarios" —
// the difference between running evals and performing them is reporting
// judge-vs-human AGREEMENT, not the judge's self-reported score alone.
//
// Every value below is `null`. That is not a placeholder score sitting in
// for a real one — it is an honest "not labeled yet." This repo is built and
// tested entirely against LLM_PROVIDER=mock (see AGENTS.md / the Task 13
// brief: a live key sits in .env, but the demo deliberately never calls it
// here). The mock provider's scenario titles and situations are
// deterministic hashed placeholder strings (e.g. "mock-title-a1b2c3"), not
// real generated content — there is nothing yet for a human to honestly
// judge for job relevance. Writing scores against that text would be a
// number that LOOKS like a human judgment without being one, which is
// exactly the failure mode this file exists to prevent.
//
// Task 15 runs scripts/run-evals.ts against the real provider. Once that
// sweep has written real curriculum output to `agent_runs` (kind="curriculum",
// grouped by brief_label), read each brief's actual generated scenario and
// replace the matching `null` below with a genuine 0-3 label using the
// Appendix A rubric:
//   0 generic, could apply to any role
//   1 loosely related to the role's domain
//   2 clearly relevant to the role
//   3 specific to a real situation this role faces, with the right register
//
// src/lib/evals.ts's `loadEvalsSummary()` reads this file directly and
// reports the judge-vs-human agreement rate only over labels that are
// non-null; with every label null (today), it reports the agreement rate as
// unavailable rather than computing one over zero pairs.
export const HUMAN_SCENARIO_RELEVANCE_LABELS: Record<string, number | null> =
  Object.fromEntries(EVAL_BRIEFS.map(b => [b.label, null]))
