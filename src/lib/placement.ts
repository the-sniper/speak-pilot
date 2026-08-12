import { asc, eq } from "drizzle-orm"
import { db } from "@/db"
import { cohorts, learners, phonemeScores, utterances, wordScores } from "@/db/schema"

// Grounding layer for program generation: every fact a placement call sees
// comes from this file, never from the model's imagination. Names and roles
// are deliberately excluded from the block the model reads — the system
// prompt (PROGRAM_GENERATION_SYSTEM_PROMPT) forbids inferring ability from
// them, so they must not even be in context to infer from.

export type LearnerWithScores = {
  id: string
  name: string
  role: string
  utterances: { id: string; accuracy: number; fluency: number; prosodic: number }[]
  missedPhonemes: { phone: string; count: number }[]
}

// Caps keep buildLearnerBlock's output compact (build guide §2d: no raw JSON
// dumps, one short block per learner) even for the learners with the most
// sessions in the seeded cohort (up to 20 utterances). Every id that IS
// listed is always real — truncation only shortens the list, it never
// fabricates or renumbers anything.
const MAX_SCORES_SHOWN = 10
const MAX_IDS_SHOWN = 10
const MAX_PHONEMES_SHOWN = 3

// A phone occurrence counts as "missed" when its cross-expert mean lands
// below 1.5 on the 0 (wrong) / 1 (accented) / 2 (correct) scale produced by
// phoneAgreement (src/lib/phonemes.ts) — i.e. experts leaned toward "wrong"
// or "accented" rather than "correct" on average for that phone.
const MISS_THRESHOLD = 1.5

function fmtScore(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

/**
 * Renders one learner's real evidence as the compact block from the build
 * guide (§2d):
 *
 *   learner_07 | 9 sessions
 *     sentence scores (accuracy/fluency/prosodic): 5/4/5, 6/5/5, ...
 *     most-missed phonemes: AE1 (7x), R (5x), TH (4x)
 *     utterance ids: u_1043, u_1051, u_1062 ...
 *
 * Deliberately excludes name and role. Deliberately excludes JSON — this text
 * goes directly into a prompt.
 */
export function buildLearnerBlock(l: LearnerWithScores): string {
  const sessionCount = l.utterances.length

  const shownScores = l.utterances.slice(0, MAX_SCORES_SHOWN)
  const scoresLine =
    shownScores.map(u => `${fmtScore(u.accuracy)}/${fmtScore(u.fluency)}/${fmtScore(u.prosodic)}`).join(", ") +
    (l.utterances.length > MAX_SCORES_SHOWN ? ", ..." : "")

  const phonemesLine = l.missedPhonemes
    .slice(0, MAX_PHONEMES_SHOWN)
    .map(p => `${p.phone} (${p.count}x)`)
    .join(", ")

  const ids = l.utterances.map(u => u.id)
  const idsLine =
    ids.slice(0, MAX_IDS_SHOWN).join(", ") + (ids.length > MAX_IDS_SHOWN ? ", ..." : "")

  return [
    `${l.id} | ${sessionCount} sessions`,
    `  sentence scores (accuracy/fluency/prosodic): ${scoresLine}`,
    `  most-missed phonemes: ${phonemesLine}`,
    `  utterance ids: ${idsLine}`,
  ].join("\n")
}

/**
 * Loads every learner in the seeded cohort along with their real sentence
 * scores and most-missed phonemes, computed straight from utterances /
 * word_scores / phoneme_scores. Two batched queries (not one per learner) so
 * loading the whole cohort stays cheap.
 */
export async function loadLearnersWithScores(): Promise<LearnerWithScores[]> {
  const learnerRows = await db
    .select({ id: learners.id, name: learners.name, role: learners.role })
    .from(learners)
    .orderBy(asc(learners.id))

  const uttRows = await db
    .select({
      id: utterances.id,
      learnerId: utterances.learnerId,
      accuracy: utterances.accuracy,
      fluency: utterances.fluency,
      prosodic: utterances.prosodic,
    })
    .from(utterances)
    .orderBy(asc(utterances.learnerId), asc(utterances.id))

  const phoneRows = await db
    .select({
      learnerId: utterances.learnerId,
      phone: phonemeScores.phone,
      mean: phonemeScores.mean,
    })
    .from(phonemeScores)
    .innerJoin(wordScores, eq(phonemeScores.wordScoreId, wordScores.id))
    .innerJoin(utterances, eq(wordScores.utteranceId, utterances.id))

  const uttByLearner = new Map<string, typeof uttRows>()
  for (const u of uttRows) {
    const arr = uttByLearner.get(u.learnerId) ?? []
    arr.push(u)
    uttByLearner.set(u.learnerId, arr)
  }

  const missByLearner = new Map<string, Map<string, number>>()
  for (const p of phoneRows) {
    if (p.mean >= MISS_THRESHOLD) continue
    const counts = missByLearner.get(p.learnerId) ?? new Map<string, number>()
    counts.set(p.phone, (counts.get(p.phone) ?? 0) + 1)
    missByLearner.set(p.learnerId, counts)
  }

  return learnerRows.map(l => {
    const utts = (uttByLearner.get(l.id) ?? []).map(u => ({
      id: u.id, accuracy: u.accuracy, fluency: u.fluency, prosodic: u.prosodic,
    }))
    const missedPhonemes = [...(missByLearner.get(l.id) ?? new Map()).entries()]
      .map(([phone, count]) => ({ phone, count }))
      .sort((a, b) => b.count - a.count)
    return { id: l.id, name: l.name, role: l.role, utterances: utts, missedPhonemes }
  })
}

/** The single seeded cohort's id — placements and programs both hang off it. */
export async function loadCohortId(): Promise<string> {
  const [row] = await db.select({ id: cohorts.id }).from(cohorts).limit(1)
  if (!row) throw new Error("No cohort found — has `npm run seed` been run?")
  return row.id
}
