import "dotenv/config"
import { randomUUID } from "crypto"
import { EVAL_BRIEFS, type EvalBrief } from "../docs/eval-briefs"
import { groundedPlacementsSchema } from "../src/lib/grounding"
import { callWithSchema } from "../src/lib/llm/adapter"
import { BAND_REFERENCE, PROGRAM_GENERATION_SYSTEM_PROMPT, SCENARIO_RELEVANCE_JUDGE_PROMPT } from "../src/lib/llm/prompts"
import { buildLearnerBlock, learnerEvidenceIds, loadLearnersWithScores, type LearnerWithScores } from "../src/lib/placement"
import { CohortSchema, CurriculumSchema, JudgeSchema } from "../src/lib/schemas"

// Runs all 20 briefs from docs/eval-briefs.ts through the same three-step
// generator POST /api/programs/generate uses (cohort -> placements ->
// curriculum), plus a scenario-relevance judge pass, tagging every
// `agent_runs` row it writes with `briefLabel`. src/lib/evals.ts's
// loadEvalsSummary() reads those rows back out and scores them — this
// script's only job is to make them exist.
//
// Deliberately does NOT persist programs/placements/programWeeks rows: the
// point of the sweep is agent_runs evidence (conformance, latency, cost,
// accuracy, judge scores), not 20 more program records cluttering the seeded
// demo data.
//
// Provider-agnostic by construction: callWithSchema resolves LLM_PROVIDER
// from the environment exactly like every other call site in this codebase.
// Run this against LLM_PROVIDER=mock during normal development (Task 13);
// Task 15 points the same, unchanged script at the real provider.

// groundedPlacementsSchema is imported from src/lib/grounding.ts — the same
// function src/app/api/programs/generate/route.ts uses, so this sweep can
// never silently diverge from the grounding rule production actually
// enforces. Code review fix round 1 on Task 13, Finding 2: this used to be a
// near-verbatim duplicate defined locally in this file.

type BriefResult =
  | { ok: true; judged: boolean }
  | { ok: false; error: string }

async function runOneBrief(
  brief: EvalBrief,
  learnerBlocks: string,
  allowedIdsByLearner: Map<string, Set<string>>,
  sweepId: string,
): Promise<BriefResult> {
  try {
    const cohortResult = await callWithSchema({
      system: PROGRAM_GENERATION_SYSTEM_PROMPT,
      prompt:
        `BRIEF: ${brief.text}\n\n` +
        "Restate what you understood about this cohort for the first card a " +
        "manager sees: size, primary L1, role, and training horizon in weeks. " +
        "If the brief is ambiguous, choose the most common enterprise " +
        "interpretation and proceed.",
      schema: CohortSchema,
      toolName: "cohort",
      kind: "cohort",
      briefLabel: brief.label,
      sweepId,
    })
    const cohort = cohortResult.data

    const placementsResult = await callWithSchema({
      system: PROGRAM_GENERATION_SYSTEM_PROMPT,
      prompt:
        `BRIEF: ${brief.text}\n\n` +
        `LEARNERS AND EVIDENCE:\n${learnerBlocks}\n\n` +
        `BAND REFERENCE:\n${BAND_REFERENCE}\n\n` +
        "Place each learner into a band using ONLY the evidence given for " +
        "that learner. Cite at least one of their utterance ids as evidence.",
      schema: groundedPlacementsSchema(allowedIdsByLearner),
      toolName: "placements",
      kind: "placement",
      briefLabel: brief.label,
      sweepId,
    })

    const placementSummary = placementsResult.data.map(p => `${p.learnerId}: ${p.band}`).join(", ")
    const horizonWeeks = Math.max(1, Math.round(cohort.horizonWeeks))
    const curriculumResult = await callWithSchema({
      system: PROGRAM_GENERATION_SYSTEM_PROMPT,
      prompt:
        `BRIEF: ${brief.text}\n\n` +
        `COHORT UNDERSTANDING: role=${cohort.role}, l1=${cohort.l1}, horizonWeeks=${horizonWeeks}\n\n` +
        `PLACEMENTS: ${placementSummary}\n\n` +
        "Produce a complete curriculum: weekly themes with scenarios, a " +
        "cadence, success criteria in plain language, and a kickoff message " +
        "in English and Korean. " +
        `Produce at most ${horizonWeeks} week${horizonWeeks === 1 ? "" : "s"} — never more than the ` +
        "program's horizon; fewer is fine if that tells the story better.",
      schema: CurriculumSchema,
      toolName: "curriculum",
      kind: "curriculum",
      briefLabel: brief.label,
      sweepId,
    })

    // Scenario-relevance judge: N=20, one representative scenario per brief
    // (the first scenario of the first week), scored against the Appendix A
    // rubric. src/lib/evals.ts pairs this against docs/eval-human-labels.ts.
    const firstScenario = curriculumResult.data.weeks[0]?.scenarios[0]
    let judged = false
    if (firstScenario) {
      await callWithSchema({
        system: SCENARIO_RELEVANCE_JUDGE_PROMPT,
        prompt:
          `ROLE: ${cohort.role}\n\n` +
          `SCENARIO TITLE: ${firstScenario.title}\n` +
          `SITUATION: ${firstScenario.situation}\n` +
          `TARGET PHRASES: ${firstScenario.targetPhrases.join("; ")}\n` +
          `SUCCESS LOOKS LIKE: ${firstScenario.successLooksLike}`,
        schema: JudgeSchema,
        toolName: "judge",
        kind: "judge",
        briefLabel: brief.label,
        sweepId,
      })
      judged = true
    }

    return { ok: true, judged }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function main(): Promise<void> {
  const provider = process.env.LLM_PROVIDER ?? "mock"
  // One id per script invocation, threaded through every callWithSchema call
  // below (all 80 rows this run writes share it) — this is what lets
  // src/lib/evals.ts's loadEvalsSummary() show exactly one sweep's numbers
  // instead of pooling every sweep ever run into the same averages. Code
  // review fix round 2 on Task 13.
  const sweepId = randomUUID()
  console.log(`Eval sweep ${sweepId}: ${EVAL_BRIEFS.length} briefs, LLM_PROVIDER=${provider}`)
  if (provider === "mock") {
    console.log(
      "Provider is mock — this sweep exercises the harness end to end (schema " +
        "conformance, latency, agent_runs plumbing) but produces no real, reportable " +
        "placement-accuracy / scenario-relevance numbers. That real sweep is Task 15.",
    )
  }

  const cohortLearners: LearnerWithScores[] = await loadLearnersWithScores()
  if (cohortLearners.length === 0) {
    throw new Error("No learners found in the seeded cohort — has `npm run seed` been run?")
  }
  const learnerBlocks = cohortLearners.map(buildLearnerBlock).join("\n\n")
  const allowedIdsByLearner = new Map(
    cohortLearners.map(l => [l.id, new Set(learnerEvidenceIds(l))]),
  )

  let succeeded = 0
  let failed = 0
  for (const brief of EVAL_BRIEFS) {
    const label = `[${brief.label}/${EVAL_BRIEFS.length}] (${brief.category})`
    process.stdout.write(`${label} ${brief.text.slice(0, 70)}${brief.text.length > 70 ? "…" : ""} ... `)
    const result = await runOneBrief(brief, learnerBlocks, allowedIdsByLearner, sweepId)
    if (result.ok) {
      succeeded++
      console.log(`ok${result.judged ? "" : " (no scenario to judge)"}`)
    } else {
      failed++
      console.log(`FAILED: ${result.error}`)
    }
  }

  console.log("")
  console.log(`Done: ${succeeded} succeeded, ${failed} failed, of ${EVAL_BRIEFS.length} briefs.`)
  // This claim was FALSE until adapter.ts's transport-error handling was
  // fixed (Task 15, found by this exact sweep hitting a real "fetch failed"
  // on brief 9): a network error thrown inside provider.call() used to skip
  // both of callWithSchema's runSink call sites entirely, so a genuine
  // failure could occur with zero trace in agent_runs. adapter.ts now wraps
  // provider.call() in its own try/catch and logs an ok=false row (error set
  // to the transport error's message, output null) before retrying or
  // rethrowing — see the doc comment in callWithSchema for the full story.
  console.log(`Every attempt (success and failure, including transport errors) was written to agent_runs, tagged with sweep_id=${sweepId}.`)
  console.log("See /evals for the scored summary — it reads only the most recent sweep.")
}

main()
  .catch(err => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    const { sql } = await import("../src/db")
    await sql.end()
  })
