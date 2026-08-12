import { z } from "zod"
import { Placement } from "./schemas"

// Shared grounding check for a model's placements array: every
// evidenceUtteranceIds entry must actually have been part of the evidence
// block shown to THAT learner (allowedIdsByLearner, built by
// src/lib/placement.ts's learnerEvidenceIds). Placement.evidenceUtteranceIds
// on its own only requires ids to be PRESENT (min(1)) — nothing in the base
// schema checks that a cited id was real evidence for that specific learner.
// A model could cite a real utterance id belonging to a DIFFERENT learner, or
// a plausible-looking id that doesn't exist at all, and it would pass schema
// validation, get persisted (or scored), and render as "grounded" evidence.
//
// Wraps the base array schema in a superRefine so a violation flows through
// callWithSchema's EXISTING retry loop (which already re-prompts on any
// schema.safeParse failure, custom issues included) rather than a second,
// bespoke retry path — reported and retried/failed exactly like a shape
// error, with the offending learner and id named in the message.
//
// Single source of truth for both callers that place the seeded cohort:
// src/app/api/programs/generate/route.ts (the real generator) and
// scripts/run-evals.ts (the eval sweep). Code review fix round 1 on Task 13,
// Finding 2: this used to be duplicated near-verbatim in both files — if the
// production grounding rule ever changed, the eval sweep would silently stop
// testing the behavior it claims to measure. Extracting it here means both
// call sites can only ever grade against the same rule.
export function groundedPlacementsSchema(allowedIdsByLearner: Map<string, Set<string>>) {
  return z.array(Placement).superRefine((rows, ctx) => {
    rows.forEach((p, i) => {
      const allowed = allowedIdsByLearner.get(p.learnerId)
      if (!allowed) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "learnerId"],
          message: `placement cites unknown learner "${p.learnerId}" — not in the seeded cohort`,
        })
        return
      }
      for (const id of p.evidenceUtteranceIds) {
        if (!allowed.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, "evidenceUtteranceIds"],
            message:
              `learner ${p.learnerId} cites utterance id "${id}" which was not in the evidence ` +
              "shown for that learner — refusing to accept unverifiable evidence",
          })
        }
      }
    })
  })
}
