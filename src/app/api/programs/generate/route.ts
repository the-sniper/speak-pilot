import { randomUUID } from "crypto"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db"
import { placements as placementsTable, programs, programWeeks, scenarios } from "@/db/schema"
import { callWithSchema } from "@/lib/llm/adapter"
import { BAND_REFERENCE, PROGRAM_GENERATION_SYSTEM_PROMPT } from "@/lib/llm/prompts"
import { buildLearnerBlock, learnerEvidenceIds, loadCohortId, loadLearnersWithScores } from "@/lib/placement"
import { CohortSchema, CurriculumSchema, Placement } from "@/lib/schemas"

// Code review fix round 1, Finding 2 (Important): Placement.evidenceUtteranceIds
// only requires ids to be PRESENT (min(1)) — nothing in the base schema checks
// that a cited id was actually part of the evidence shown to that specific
// learner. A model could cite a real utterance id belonging to a DIFFERENT
// learner, or a plausible-looking id that doesn't exist at all, and it would
// pass schema validation, get persisted, and render as "grounded" evidence.
// This wraps the base array schema in a superRefine that checks each
// placement's citations against `allowedIdsByLearner` — exactly the ids
// `learnerEvidenceIds` put in that learner's block (see placement.ts). It
// plugs into callWithSchema's EXISTING retry loop (which already re-prompts
// on any schema.safeParse failure, custom issues included) rather than
// bolting on a second, bespoke retry path — a violation is reported and
// retried/failed exactly like a shape error, with the offending learner and
// id named in the message.
function groundedPlacementsSchema(allowedIdsByLearner: Map<string, Set<string>>) {
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
              "shown for that learner — refusing to persist unverifiable evidence",
          })
        }
      }
    })
  })
}

// Fix round 2 on Task 12, Finding 1: the persist loop renumbers curriculum
// weeks to n = array index + 1 (fix round 1), which guarantees SEQUENTIAL,
// duplicate-free numbering — but nothing bounded the COUNT. CurriculumSchema
// (src/lib/schemas.ts) has no min/max on `weeks` and no cross-check against
// horizonWeeks, so a provider returning MORE weeks than the horizon would
// still get every one of them persisted, with n running past horizonWeeks —
// rows getProgramOverview's read-side guard would correctly hide from the
// tile list (it only ever shows 1..horizonWeeks), but that a real model has
// no reason not to produce, unlike the mock's fixed-length output. Same
// pattern as groundedPlacementsSchema above: a violation is a
// schema.safeParse failure, so it flows through callWithSchema's EXISTING
// retry loop — a real model gets a re-prompt with the named error instead of
// this route silently writing rows past the horizon (or a mock-only band-aid
// that a live model could still slip past).
//
// Rejects only weeks.length > horizonWeeks, not weeks.length !== horizonWeeks:
// the advance route already has a documented, working "fewer weeks than
// horizon" fallback (it creates a row on demand, keyed by sequential
// weekNumber, the first time a week beyond what curriculum generation
// produced needs to be advanced) — the mock provider currently always
// returns exactly 2 weeks regardless of horizon, and requiring an exact
// match would turn that pre-existing, already-handled shortfall into a
// retry loop (and, with a live provider, a real re-prompt cost) for a shape
// of curriculum this codebase already knows how to serve correctly. Only
// "more weeks than the program can ever show" is the actual defect this
// closes.
function groundedCurriculumSchema(horizonWeeks: number) {
  return CurriculumSchema.superRefine((data, ctx) => {
    if (data.weeks.length > horizonWeeks) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["weeks"],
        message:
          `curriculum returned ${data.weeks.length} weeks, more than the ${horizonWeeks}-week horizon — ` +
          "every persisted week must fall inside 1..horizonWeeks",
      })
    }
  })
}

export const runtime = "nodejs"
export const maxDuration = 60

// Build guide §4: "aim for a section every 1.5 to 3 seconds, roughly 12 to 20
// seconds total" so the stream reads as a system doing work, not a canned
// animation. Real provider latency supplies most of that naturally; the mock
// provider returns instantly, so this floor fills the gap between frames.
// Zero in tests (NODE_ENV=test under vitest) so the suite stays fast.
const PACE_MS = process.env.NODE_ENV === "test" ? 0 : 1600

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve()
}

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}))
  const brief = typeof (body as { brief?: unknown })?.brief === "string" ? (body as { brief: string }).brief : ""

  const encoder = new TextEncoder()
  let sentAnyFrame = false

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = async (event: string, data: unknown, opts?: { immediate?: boolean }) => {
        if (sentAnyFrame && !opts?.immediate) await sleep(PACE_MS)
        sentAnyFrame = true
        controller.enqueue(encoder.encode(sseFrame(event, data)))
      }
      const emitSection = (key: string, payload: unknown) => emit("section", { key, payload })

      const programId = randomUUID()

      try {
        // Step 1: parse the brief into a cohort understanding. Emit `cohort`.
        const cohortResult = await callWithSchema({
          system: PROGRAM_GENERATION_SYSTEM_PROMPT,
          prompt:
            `BRIEF: ${brief}\n\n` +
            "Restate what you understood about this cohort for the first card a " +
            "manager sees: size, primary L1, role, and training horizon in weeks. " +
            "If the brief is ambiguous, choose the most common enterprise " +
            "interpretation and proceed.",
          schema: CohortSchema,
          toolName: "cohort",
          kind: "cohort",
        })
        const cohort = cohortResult.data

        const cohortId = await loadCohortId()
        const cohortLearners = await loadLearnersWithScores()
        if (cohortLearners.length === 0) {
          throw new Error("No learners found in the seeded cohort — has `npm run seed` been run?")
        }

        // Extracted so the curriculum step below can ground weeks.length
        // against the exact same number the programs row itself carries
        // (fix round 2, Finding 1) — a second, independently-rounded copy of
        // this expression would risk drifting from what actually got
        // persisted as this program's horizon.
        const horizonWeeks = Math.max(1, Math.round(cohort.horizonWeeks))

        // Persist as we go: a mid-stream refresh must not lose the cohort card.
        await db.insert(programs).values({
          id: programId,
          cohortId,
          brief,
          cohortSummary: cohort,
          horizonWeeks,
          currentWeek: 0,
        })
        await emitSection("cohort", cohort)

        // Step 2: placement over grounded per-learner evidence blocks. Emit
        // `placements`. Every learner in the seeded cohort is placed — the
        // brief's stated headcount is what the cohort card reports, not what
        // determines who gets grounded evidence and a placement.
        const learnerBlocks = cohortLearners.map(buildLearnerBlock).join("\n\n")
        const allowedIdsByLearner = new Map(
          cohortLearners.map(l => [l.id, new Set(learnerEvidenceIds(l))]),
        )
        const placementsResult = await callWithSchema({
          system: PROGRAM_GENERATION_SYSTEM_PROMPT,
          prompt:
            `BRIEF: ${brief}\n\n` +
            `LEARNERS AND EVIDENCE:\n${learnerBlocks}\n\n` +
            `BAND REFERENCE:\n${BAND_REFERENCE}\n\n` +
            "Place each learner into a band using ONLY the evidence given for " +
            "that learner. Cite at least one of their utterance ids as evidence.",
          schema: groundedPlacementsSchema(allowedIdsByLearner),
          toolName: "placements",
          kind: "placement",
        })
        const placementRows = placementsResult.data

        // Persisted before step 3 runs — a step-3 failure below must not
        // discard this work.
        if (placementRows.length > 0) {
          await db.insert(placementsTable).values(placementRows.map(p => ({
            id: randomUUID(),
            programId,
            learnerId: p.learnerId,
            band: p.band,
            rationale: p.rationale,
            evidenceUtteranceIds: p.evidenceUtteranceIds,
          })))
        }
        await emitSection("placements", placementRows)

        // Step 3: curriculum, cadence, success criteria, kickoff message.
        // Emits four frames from this one call.
        const placementSummary = placementRows.map(p => `${p.learnerId}: ${p.band}`).join(", ")
        const curriculumResult = await callWithSchema({
          system: PROGRAM_GENERATION_SYSTEM_PROMPT,
          prompt:
            `BRIEF: ${brief}\n\n` +
            `COHORT UNDERSTANDING: role=${cohort.role}, l1=${cohort.l1}, ` +
            `horizonWeeks=${horizonWeeks}\n\n` +
            `PLACEMENTS: ${placementSummary}\n\n` +
            "Produce a complete curriculum: weekly themes with scenarios, a " +
            "cadence, success criteria in plain language, and a kickoff message " +
            "in English and Korean. " +
            `Produce at most ${horizonWeeks} week${horizonWeeks === 1 ? "" : "s"} — never more than the ` +
            "program's horizon; fewer is fine if that tells the story better.",
          schema: groundedCurriculumSchema(horizonWeeks),
          toolName: "curriculum",
          kind: "curriculum",
        })
        const curriculum = curriculumResult.data

        await db.update(programs).set({
          cadence: curriculum.cadence,
          successCriteria: curriculum.successCriteria,
          kickoff: curriculum.kickoffMessage,
        }).where(eq(programs.id, programId))

        // Fix round 1 on Task 12, Finding 1(b): `week.n` is the MODEL's own
        // number, and CurriculumSchema never constrained it to be unique or
        // to fall inside 1..horizonWeeks — a real model can emit garbage
        // here exactly as easily as the mock did (which collided on the same
        // n for every week, deterministically, regardless of horizon; see
        // src/lib/llm/providers/mock.ts). The rows this loop persists are
        // the ones every downstream reader (program-view.ts, the advance
        // route's existingWeekRow lookup) keys off of by n, so normalizing
        // HERE — to the week's plain position in the array, 1-indexed — is
        // the one place that guarantees every program's weeks are sequential
        // and duplicate-free at the source, for a mock OR a real provider,
        // without spending a retry (and, with a live key in .env, real
        // money) re-prompting the model over what is purely a numbering
        // cosmetic. `week.n` itself is still whatever the model said — nothing
        // downstream reads it once persisted, so nothing is lost by not
        // trusting it for the column that actually drives navigation.
        for (const [i, week] of curriculum.weeks.entries()) {
          const weekId = randomUUID()
          const n = i + 1
          await db.insert(programWeeks).values({
            id: weekId,
            programId,
            n,
            theme: week.theme,
          })
          if (week.scenarios.length > 0) {
            await db.insert(scenarios).values(week.scenarios.map(s => ({
              id: randomUUID(),
              weekId,
              title: s.title,
              situation: s.situation,
              targetPhrases: s.targetPhrases,
              successLooksLike: s.successLooksLike,
            })))
          }
        }

        await emitSection("weeks", curriculum.weeks)
        await emitSection("cadence", curriculum.cadence)
        await emitSection("successCriteria", curriculum.successCriteria)
        await emitSection("kickoff", curriculum.kickoffMessage)

        await emit("done", { programId })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // Minor fix, code review round 1: an error frame must reach the
        // client immediately, not wait out the pacing floor meant for the
        // "system doing work" feel of a successful stream.
        await emit("error", { message }, { immediate: true })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}
