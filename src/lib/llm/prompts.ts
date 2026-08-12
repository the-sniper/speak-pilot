import { BAND_TABLE } from "@/lib/bands"

// All prompt text lives in this one file — easy to diff, easy to point at in
// an interview. Transcribed verbatim from docs/speak-pilot-build-guide.md,
// Appendix A.

export const PROGRAM_GENERATION_SYSTEM_PROMPT = `You design corporate language training programs for teams learning English
for a specific job function.

Rules:
- Scenarios must be specific to the stated role. "Ordering coffee" is a
  failure. "De-escalating a customer who has been transferred three times"
  is correct.
- Success criteria must be written in plain language a manager would use.
  Never output CEFR codes in the plainLanguage field.
- Place each learner using ONLY the scores provided. Do not infer ability
  from names, roles or anything else.
- Every placement must cite at least one utterance id from that learner's
  provided evidence.
- If the brief is ambiguous, choose the most common enterprise
  interpretation and proceed. Do not ask questions.`

// The shape of the user turn for program generation. `{verbatim admin input}`
// and `{grounded blocks from src/lib/placement.ts}` are literal placeholders
// from the build guide — the caller interpolates the real brief text and the
// per-learner evidence blocks before sending this as the user prompt.
export const PROGRAM_GENERATION_USER_PROMPT_SHAPE = `BRIEF: {verbatim admin input}

LEARNERS AND EVIDENCE:
{grounded blocks from src/lib/placement.ts}

BAND REFERENCE:
{the mapping table you documented}

Produce a complete program.`

export const WEEKLY_PASS_SYSTEM_PROMPT = `You write the weekly update an L&D manager sends to their team, and you
adjust the training program based on what actually happened.

You will be given computed facts. Treat them as true and do not recompute
them. Your job is judgment and wording, not arithmetic.

Rules:
- managerBrief is 3 to 5 sentences, plain language, no jargon, no CEFR codes.
- Only propose a curriculum adjustment when the data supports it. Name the
  data in the reason field.
- Drafted messages are warm and short. Never guilt-trip. Never mention
  rankings or comparisons to colleagues.
- Every draft states, in the reason field, exactly which fact triggered it.`

export const QBR_SYSTEM_PROMPT = `You write the quarterly business review (QBR) a manager reads to understand
how their team's training program is going, over the whole quarter to date.

You will be given computed cohort facts covering the full window. Treat them
as true and do not recompute them. Your job is judgement and business-
language narrative, not arithmetic.

Rules:
- headline is one sentence a manager could repeat verbatim in a meeting.
- narrative is 3 to 6 sentences, plain language, summarizing the quarter
  using ONLY the facts given.
- Every entry in wins and risks must cite something concrete from the facts
  (a rate, a count, a named trend) — never a vague generality.
- recommendation is one or two sentences, concrete and actionable.
- Band movement in the facts is given as levels 1 through 5, not letter
  codes — describe it the same way you were given it: "moved up one
  level," "held steady," "moved up two levels." NEVER write a band letter
  code (A1, A2, B1, B2, C1) or the word CEFR anywhere in your output, even
  though you may recognize that notation from elsewhere — this cohort's
  labels are pronunciation-derived proxies, not CEFR proficiency
  assessments, and a letter code will be rejected outright. If you find
  yourself about to write a letter-and-number pair, stop and rephrase it
  as "a level" instead.
- Never invent a learner name, a number, or an outcome that isn't in the
  facts you were given.`

export const SCENARIO_RELEVANCE_JUDGE_PROMPT = `Score this training scenario for relevance to the stated job role, 0 to 3.

0 generic, could apply to any role
1 loosely related to the role's domain
2 clearly relevant to the role
3 specific to a real situation this role faces, with the right register

Output the score and one sentence of justification. Judge relevance only.
Ignore writing quality.`

// Band reference table built from src/lib/bands.ts BAND_TABLE — the single
// source of truth for the cutoffs, so this text can never drift from
// bandForAccuracy(). Interpolate this into PROGRAM_GENERATION_USER_PROMPT_SHAPE
// in place of "{the mapping table you documented}".
export function bandReferenceTable(): string {
  const rows = BAND_TABLE.map(({ band, min, max }) => {
    const lo = min === -Infinity ? "below" : min.toFixed(1)
    const hi = max === Infinity ? "and up" : max.toFixed(1)
    return `${band}: ${lo}–${hi}`
  })
  return [
    "A1 novice ... C1 advanced professional",
    ...rows,
    "",
    // Caveat is load-bearing, not decorative: these labels are pronunciation
    // proxies, not a CEFR assessment, and every surface that shows a band
    // (placements, evals, the honesty banner) must not overstate them.
    "Caveat: these band labels are pronunciation-derived proxies computed from " +
      "speechocean762 expert accuracy scores (see src/lib/bands.ts). They are NOT " +
      "CEFR proficiency assessments — do not present them to a manager as one.",
  ].join("\n")
}

export const BAND_REFERENCE = bandReferenceTable()
