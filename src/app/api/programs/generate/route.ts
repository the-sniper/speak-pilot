import { randomUUID } from "crypto"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db"
import { placements as placementsTable, programs, programWeeks, scenarios } from "@/db/schema"
import { callWithSchema } from "@/lib/llm/adapter"
import { BAND_REFERENCE, PROGRAM_GENERATION_SYSTEM_PROMPT } from "@/lib/llm/prompts"
import { buildLearnerBlock, loadCohortId, loadLearnersWithScores } from "@/lib/placement"
import { CohortSchema, CurriculumSchema, Placement } from "@/lib/schemas"

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
      const emit = async (event: string, data: unknown) => {
        if (sentAnyFrame) await sleep(PACE_MS)
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

        // Persist as we go: a mid-stream refresh must not lose the cohort card.
        await db.insert(programs).values({
          id: programId,
          cohortId,
          brief,
          cohortSummary: cohort,
          horizonWeeks: Math.max(1, Math.round(cohort.horizonWeeks)),
          currentWeek: 0,
        })
        await emitSection("cohort", cohort)

        // Step 2: placement over grounded per-learner evidence blocks. Emit
        // `placements`. Every learner in the seeded cohort is placed — the
        // brief's stated headcount is what the cohort card reports, not what
        // determines who gets grounded evidence and a placement.
        const learnerBlocks = cohortLearners.map(buildLearnerBlock).join("\n\n")
        const placementsResult = await callWithSchema({
          system: PROGRAM_GENERATION_SYSTEM_PROMPT,
          prompt:
            `BRIEF: ${brief}\n\n` +
            `LEARNERS AND EVIDENCE:\n${learnerBlocks}\n\n` +
            `BAND REFERENCE:\n${BAND_REFERENCE}\n\n` +
            "Place each learner into a band using ONLY the evidence given for " +
            "that learner. Cite at least one of their utterance ids as evidence.",
          schema: z.array(Placement),
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
            `horizonWeeks=${cohort.horizonWeeks}\n\n` +
            `PLACEMENTS: ${placementSummary}\n\n` +
            "Produce a complete curriculum: weekly themes with scenarios, a " +
            "cadence, success criteria in plain language, and a kickoff message " +
            "in English and Korean.",
          schema: CurriculumSchema,
          toolName: "curriculum",
          kind: "curriculum",
        })
        const curriculum = curriculumResult.data

        await db.update(programs).set({
          cadence: curriculum.cadence,
          successCriteria: curriculum.successCriteria,
          kickoff: curriculum.kickoffMessage,
        }).where(eq(programs.id, programId))

        for (const week of curriculum.weeks) {
          const weekId = randomUUID()
          await db.insert(programWeeks).values({
            id: weekId,
            programId,
            n: week.n,
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
        await emit("error", { message })
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
