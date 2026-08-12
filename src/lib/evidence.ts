import { and, asc, eq, inArray } from "drizzle-orm"
import { db } from "@/db"
import {
  expertScores, learners, phonemeScores, placements, utterances, wordScores,
} from "@/db/schema"
import type { Band } from "@/lib/bands"

// Single place every placement-evidence query flows through — the evidence
// panel's two read paths (by placement id, and by programId+learnerId before
// the client even knows the placement id) both terminate in `buildEvidence`,
// so there is exactly one join to keep correct, not two copies that can
// silently drift.

export type PhonemeEvidence = {
  idx: number
  phone: string
  mean: number
  scores: number[]
  disagreement: number
  insertionsAfter: string[]
}

export type WordEvidence = {
  idx: number
  text: string
  accuracy: number
  stress: number
  total: number
  refPhones: string
  phonemes: PhonemeEvidence[]
}

export type ExpertUtteranceScore = {
  expertIdx: number
  accuracy: number
  fluency: number
  prosodic: number
  completeness: number
}

export type UtteranceEvidence = {
  id: string
  text: string
  audioPath: string
  accuracy: number
  fluency: number
  prosodic: number
  completeness: number
  total: number
  words: WordEvidence[]
  expertScores: ExpertUtteranceScore[]
}

export type PlacementEvidence = {
  id: string
  programId: string
  learnerId: string
  band: Band
  overriddenBand: Band | null
  rationale: string
  evidenceUtteranceIds: string[]
  // null only if `learners` is missing the row `placements.learnerId`
  // references — which the schema's NOT NULL FK makes unreachable today.
  // Left null rather than fabricated (e.g. the id standing in for a name)
  // for the same reason the evidenceUtteranceIds join below refuses to
  // paper over a missing utterance: a hole here is a data integrity bug
  // upstream, and the UI must be able to tell "no data" from "a real name"
  // rather than silently rendering a learner id as if it were a person.
  learner: { id: string; name: string; role: string } | null
  utterances: UtteranceEvidence[]
}

type PlacementRow = typeof placements.$inferSelect

async function buildEvidence(row: PlacementRow): Promise<PlacementEvidence> {
  const evidenceUtteranceIds = row.evidenceUtteranceIds as string[]

  const [learnerRow] = await db
    .select({ id: learners.id, name: learners.name, role: learners.role })
    .from(learners)
    .where(eq(learners.id, row.learnerId))
    .limit(1)

  // A placement's evidence citations are always real utterance ids (enforced
  // server-side at generation time — see groundedPlacementsSchema in
  // src/app/api/programs/generate/route.ts), so an empty result here would
  // mean the citation was never grounded; that would be a data integrity bug
  // upstream, not something to paper over with a fabricated fallback row.
  const uttRows = evidenceUtteranceIds.length
    ? await db.select().from(utterances).where(inArray(utterances.id, evidenceUtteranceIds))
    : []
  const uttById = new Map(uttRows.map(u => [u.id, u]))

  const wordRows = evidenceUtteranceIds.length
    ? await db
        .select()
        .from(wordScores)
        .where(inArray(wordScores.utteranceId, evidenceUtteranceIds))
        .orderBy(asc(wordScores.utteranceId), asc(wordScores.idx))
    : []
  const wordIds = wordRows.map(w => w.id)

  const phoneRows = wordIds.length
    ? await db
        .select()
        .from(phonemeScores)
        .where(inArray(phonemeScores.wordScoreId, wordIds))
        .orderBy(asc(phonemeScores.wordScoreId), asc(phonemeScores.idx))
    : []
  const phonesByWordId = new Map<number, PhonemeEvidence[]>()
  for (const p of phoneRows) {
    const arr = phonesByWordId.get(p.wordScoreId) ?? []
    arr.push({
      idx: p.idx,
      phone: p.phone,
      mean: p.mean,
      scores: p.scores as number[],
      disagreement: p.disagreement,
      insertionsAfter: p.insertionsAfter as string[],
    })
    phonesByWordId.set(p.wordScoreId, arr)
  }

  const wordsByUtterance = new Map<string, WordEvidence[]>()
  for (const w of wordRows) {
    const arr = wordsByUtterance.get(w.utteranceId) ?? []
    arr.push({
      idx: w.idx,
      text: w.text,
      accuracy: w.accuracy,
      stress: w.stress,
      total: w.total,
      refPhones: w.refPhones,
      phonemes: phonesByWordId.get(w.id) ?? [],
    })
    wordsByUtterance.set(w.utteranceId, arr)
  }

  const expertRows = evidenceUtteranceIds.length
    ? await db
        .select()
        .from(expertScores)
        .where(inArray(expertScores.utteranceId, evidenceUtteranceIds))
        .orderBy(asc(expertScores.utteranceId), asc(expertScores.expertIdx))
    : []
  const expertsByUtterance = new Map<string, ExpertUtteranceScore[]>()
  for (const e of expertRows) {
    const arr = expertsByUtterance.get(e.utteranceId) ?? []
    arr.push({
      expertIdx: e.expertIdx,
      accuracy: e.accuracy,
      fluency: e.fluency,
      prosodic: e.prosodic,
      completeness: e.completeness,
    })
    expertsByUtterance.set(e.utteranceId, arr)
  }

  // Preserve the order the model cited them in, not DB return order, and
  // silently drop any citation whose utterance row is missing rather than
  // throw — a single dangling id should not take down the whole panel.
  const utteranceEvidence: UtteranceEvidence[] = evidenceUtteranceIds
    .map(id => uttById.get(id))
    .filter((u): u is typeof uttRows[number] => u !== undefined)
    .map(u => ({
      id: u.id,
      text: u.text,
      audioPath: u.audioPath,
      accuracy: u.accuracy,
      fluency: u.fluency,
      prosodic: u.prosodic,
      completeness: u.completeness,
      total: u.total,
      words: wordsByUtterance.get(u.id) ?? [],
      expertScores: expertsByUtterance.get(u.id) ?? [],
    }))

  return {
    id: row.id,
    programId: row.programId,
    learnerId: row.learnerId,
    band: row.band as Band,
    overriddenBand: (row.overriddenBand as Band | null) ?? null,
    rationale: row.rationale,
    evidenceUtteranceIds,
    learner: learnerRow ?? null,
    utterances: utteranceEvidence,
  }
}

export async function getPlacementEvidenceById(id: string): Promise<PlacementEvidence | null> {
  const [row] = await db.select().from(placements).where(eq(placements.id, id)).limit(1)
  if (!row) return null
  return buildEvidence(row)
}

export async function getPlacementEvidenceByLearner(
  programId: string,
  learnerId: string,
): Promise<PlacementEvidence | null> {
  const [row] = await db
    .select()
    .from(placements)
    .where(and(eq(placements.programId, programId), eq(placements.learnerId, learnerId)))
    .limit(1)
  if (!row) return null
  return buildEvidence(row)
}
