import "dotenv/config"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { db, sql } from "../src/db"
import * as schema from "../src/db/schema"
import { selectCohort, weekPlan, type SpeakerStats } from "./select-cohort"
import { bandForAccuracy } from "../src/lib/bands"
import { phoneAgreement } from "../src/lib/phonemes"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")
// Root: ../.speak-pilot-data/speechocean762/ relative to the repo root. READ-ONLY —
// never copy, move, or modify anything under this tree.
const DATA_ROOT = path.resolve(REPO_ROOT, "..", ".speak-pilot-data", "speechocean762")
const AUDIO_OUT = path.join(REPO_ROOT, "public", "audio")

const HORIZON_WEEKS = 10 // Seoul demo brief
const SEED = 42

const ORG_ID = "org-northwind"
const COHORT_ID = "cohort-seoul-support-pilot"

// Fictional Northwind Support personas. Independent fiction — NOT derived from the
// corpus's real spk2age/spk2gender (which this script never reads). Assigned to the
// selected learners purely by array index, in selectCohort's seeded output order.
const PERSONAS: { name: string; role: string }[] = [
  { name: "Grace Okafor", role: "Support Engineer" },
  { name: "Daniel Ruiz", role: "Customer Success Associate" },
  { name: "Priya Natarajan", role: "Technical Support Specialist" },
  { name: "Marcus Webb", role: "Support Team Lead" },
  { name: "Elena Popescu", role: "Onboarding Specialist" },
  { name: "Sofia Almeida", role: "Escalations Specialist" },
  { name: "Noah Kim", role: "Live Chat Support Agent" },
  { name: "Aisha Bello", role: "Support Operations Analyst" },
  { name: "Liam Carter", role: "Bilingual Support Agent" },
  { name: "Yuki Tanaka", role: "QA Support Analyst" },
  { name: "Fatima Haidari", role: "Support Engineer" },
  { name: "Ethan Brooks", role: "Customer Success Associate" },
  { name: "Ines Duarte", role: "Technical Support Specialist" },
  { name: "Omar Haddad", role: "Support Engineer" },
  { name: "Chloe Martin", role: "Escalations Specialist" },
  { name: "Ravi Chandran", role: "Live Chat Support Agent" },
  { name: "Isabela Santos", role: "Customer Success Associate" },
  { name: "Lucas Ferreira", role: "Support Engineer" },
  { name: "Nadia Petrov", role: "Onboarding Specialist" },
  { name: "Jacob Lindgren", role: "Technical Support Specialist" },
  { name: "Maya Cohen", role: "Support Operations Analyst" },
  { name: "Tomas Novak", role: "Support Engineer" },
  { name: "Zoe Whitfield", role: "Customer Success Associate" },
  { name: "Ahmed Farouk", role: "Bilingual Support Agent" },
]

type ScoresJson = Record<string, {
  accuracy: number; completeness: number; fluency: number; prosodic: number; total: number
  text: string
  words: {
    accuracy: number; stress: number; total: number; text: string
    phones: string[]; "phones-accuracy": number[]
  }[]
}>

type ScoresDetailJson = Record<string, {
  accuracy: number[]; completeness: number[]; fluency: number[]; prosodic: number[]; total: number[]
  text: string
  words: {
    accuracy: number[]; stress: number[]; total: number[]; text: string
    "ref-phones": string; phones: string[]
  }[]
}>

function readUtt2Spk(file: string): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const line of fs.readFileSync(file, "utf8").trim().split("\n")) {
    const [utt, spk] = line.trim().split(/\s+/)
    if (!utt || !spk) continue
    const arr = map.get(spk) ?? []
    arr.push(utt)
    map.set(spk, arr)
  }
  return map
}

function readWavScp(file: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of fs.readFileSync(file, "utf8").trim().split("\n")) {
    const [utt, rel] = line.split("\t")
    if (utt && rel) map.set(utt, rel)
  }
  return map
}

function assertFinite(value: number, label: string): number {
  // MANDATORY GUARD: bandForAccuracy(NaN) silently returns "C1" — the TOP band —
  // because every comparison against NaN is false, so the for-loop falls through
  // to its default. true_band is the eval ground truth; one NaN speaker mean
  // would silently inflate the placement-accuracy headline. Every score written
  // to the DB (speaker means, utterance scores, word scores, phoneme means) is
  // asserted finite before the insert instead, and throws loudly by name if not.
  if (!Number.isFinite(value)) throw new Error(`Non-finite score (${label}): ${value}`)
  return value
}

function detectOpusSupport(): boolean {
  try {
    const out = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" })
    return /libopus/.test(out)
  } catch {
    return false
  }
}

async function main() {
  const AUDIO_EXT = detectOpusSupport() ? "opus" : "mp3"
  if (AUDIO_EXT === "mp3") {
    console.warn("libopus encoder not available in this ffmpeg build — falling back to mp3")
  }

  console.log("Loading speechocean762 corpus from", DATA_ROOT)
  const scores: ScoresJson = JSON.parse(
    fs.readFileSync(path.join(DATA_ROOT, "resource/scores.json"), "utf8"),
  )
  const detail: ScoresDetailJson = JSON.parse(
    fs.readFileSync(path.join(DATA_ROOT, "resource/scores-detail.json"), "utf8"),
  )

  // train/ and test/ are disjoint speaker splits (125 speakers each) — read both.
  const utt2spkTrain = readUtt2Spk(path.join(DATA_ROOT, "train/utt2spk"))
  const utt2spkTest = readUtt2Spk(path.join(DATA_ROOT, "test/utt2spk"))
  const wavScpTrain = readWavScp(path.join(DATA_ROOT, "train/wav.scp"))
  const wavScpTest = readWavScp(path.join(DATA_ROOT, "test/wav.scp"))

  const spkToUtts = new Map<string, string[]>()
  for (const [spk, utts] of [...utt2spkTrain, ...utt2spkTest]) {
    if (spkToUtts.has(spk)) throw new Error(`Speaker ${spk} present in both train and test splits`)
    spkToUtts.set(spk, [...utts].sort())
  }
  const wavPath = new Map<string, string>([...wavScpTrain, ...wavScpTest])

  // ---- Build SpeakerStats ----
  // expertMeanAccuracy = mean over the speaker's utterances of (mean over the 5
  // experts' accuracy for that utterance), using scores-detail.json (per-expert),
  // never scores.json's single aggregated number.
  const corpus: SpeakerStats[] = []
  const corpusBySpeaker = new Map<string, SpeakerStats>()
  for (const [speakerId, uttIds] of spkToUtts) {
    const perUttMeans: number[] = []
    const utteranceTotals: number[] = []
    for (const uid of uttIds) {
      const accs = detail[uid]?.accuracy
      if (!accs || accs.length !== 5) {
        throw new Error(`Speaker ${speakerId} utterance ${uid}: expected 5 expert accuracy scores, got ${accs?.length ?? 0}`)
      }
      const uttMean = accs.reduce((a, b) => a + b, 0) / accs.length
      assertFinite(uttMean, `speaker ${speakerId} utterance ${uid} expert-mean accuracy`)
      perUttMeans.push(uttMean)

      const total = scores[uid]?.total
      if (total === undefined) throw new Error(`Speaker ${speakerId} utterance ${uid}: missing scores.json entry`)
      assertFinite(total, `speaker ${speakerId} utterance ${uid} total`)
      utteranceTotals.push(total)
    }
    const meanAccuracy = perUttMeans.reduce((a, b) => a + b, 0) / perUttMeans.length
    assertFinite(meanAccuracy, `speaker ${speakerId} expertMeanAccuracy`)

    const stats: SpeakerStats = { speakerId, meanAccuracy, utteranceTotals, utteranceIds: uttIds }
    corpus.push(stats)
    corpusBySpeaker.set(speakerId, stats)
  }
  console.log(`Built stats for ${corpus.length} speakers`)

  const selected = selectCohort(corpus, SEED)
  console.log(`selectCohort chose ${selected.length} learners`)

  if (selected.length !== PERSONAS.length) {
    throw new Error(`selectCohort returned ${selected.length} learners but only ${PERSONAS.length} personas are defined`)
  }

  // ---- Clear tables (FK-safe via CASCADE) so the seed is re-runnable ----
  console.log("Clearing existing seed data...")
  await sql`truncate table
    drafts, agent_runs, placements, scenarios, program_weeks, programs,
    phoneme_scores, word_scores, expert_scores, utterances, sessions, learners,
    cohorts, orgs
    restart identity cascade`

  await db.insert(schema.orgs).values({ id: ORG_ID, name: "Northwind Support" })
  await db.insert(schema.cohorts).values({
    id: COHORT_ID, orgId: ORG_ID, name: "Seoul Support Pilot — Cohort 1",
  })

  const audioNeeded: { uttId: string; srcWav: string }[] = []
  let sessionCount = 0
  let utteranceCount = 0
  let wordScoreCount = 0
  let phonemeScoreCount = 0
  let expertScoreCount = 0

  for (let i = 0; i < selected.length; i++) {
    const sel = selected[i]
    const persona = PERSONAS[i]
    const stats = corpusBySpeaker.get(sel.speakerId)
    if (!stats) throw new Error(`No SpeakerStats for selected speaker ${sel.speakerId}`)

    const learnerId = `learner-${sel.speakerId}`
    const trueBand = bandForAccuracy(sel.meanAccuracy)

    await db.insert(schema.learners).values({
      id: learnerId,
      cohortId: COHORT_ID,
      speakerId: sel.speakerId,
      name: persona.name,
      role: persona.role,
      arc: sel.arc,
      expertMeanAccuracy: sel.meanAccuracy,
      trueBand,
    })

    // Cadence is derived from the speaker's FULL utterance count (not the
    // "stopped" arc's truncated id list) — this is what makes a stopped
    // learner's later weeks come up with no utterances (and completed:false)
    // instead of compressing their whole program into fewer, denser weeks.
    //
    // NOTE ON CONSTRUCTED TRAJECTORY: speechocean762 records one sitting per
    // speaker with no time dimension. Assigning a speaker's utterances to weeks
    // here is a narrative device for the demo, not a measured longitudinal
    // trend — disclosed in the app's honesty banner.
    const plan = weekPlan(stats.utteranceIds.length, HORIZON_WEEKS)
    const remainingIds = [...sel.utteranceIds]

    for (let week = 1; week <= HORIZON_WEEKS; week++) {
      const weekIds = remainingIds.splice(0, plan[week - 1])
      const completed = weekIds.length > 0
      const sessionId = `session-${sel.speakerId}-w${week}`

      await db.insert(schema.sessions).values({ id: sessionId, learnerId, weekN: week, completed })
      sessionCount++

      for (const uttId of weekIds) {
        const utt = scores[uttId]
        const det = detail[uttId]
        if (!utt || !det) throw new Error(`Missing scores for utterance ${uttId}`)

        const accuracy = assertFinite(utt.accuracy, `utterance ${uttId} accuracy`)
        const fluency = assertFinite(utt.fluency, `utterance ${uttId} fluency`)
        const prosodic = assertFinite(utt.prosodic, `utterance ${uttId} prosodic`)
        // scores.json's completeness is 0-10 — the same scale as accuracy/fluency/
        // prosodic/total here. scores-detail's per-expert completeness (used below
        // for expert_scores) is 0-1. Same quantity, different scale — the "SCALE
        // TRAP" — do not mix them.
        const completeness = assertFinite(utt.completeness, `utterance ${uttId} completeness`)
        const total = assertFinite(utt.total, `utterance ${uttId} total`)

        await db.insert(schema.utterances).values({
          id: uttId,
          sessionId,
          learnerId,
          text: utt.text,
          audioPath: `/audio/${uttId}.${AUDIO_EXT}`,
          accuracy, fluency, prosodic, completeness, total,
        })
        utteranceCount++

        const relWav = wavPath.get(uttId)
        if (!relWav) throw new Error(`No wav.scp entry for utterance ${uttId}`)
        audioNeeded.push({ uttId, srcWav: path.join(DATA_ROOT, relWav) })

        if (det.words.length !== utt.words.length) {
          throw new Error(`Word count mismatch for utterance ${uttId}: scores=${utt.words.length} detail=${det.words.length}`)
        }

        for (let wIdx = 0; wIdx < det.words.length; wIdx++) {
          const dw = det.words[wIdx]
          const sw = utt.words[wIdx]

          const wAccuracy = assertFinite(sw.accuracy, `utterance ${uttId} word ${wIdx} accuracy`)
          const wStress = assertFinite(sw.stress, `utterance ${uttId} word ${wIdx} stress`)
          const wTotal = assertFinite(sw.total, `utterance ${uttId} word ${wIdx} total`)

          const [{ id: wordScoreId }] = await db.insert(schema.wordScores).values({
            utteranceId: uttId,
            idx: wIdx,
            text: sw.text,
            accuracy: wAccuracy,
            stress: wStress,
            total: wTotal,
            refPhones: dw["ref-phones"],
          }).returning({ id: schema.wordScores.id })
          wordScoreCount++

          // Lets malformed markup throw loudly rather than swallowing it — a
          // throw here means our understanding of the corpus's phone notation
          // is wrong and needs to be surfaced, not hidden.
          const agreement = phoneAgreement(dw["ref-phones"], dw.phones)
          if (agreement.length > 0) {
            await db.insert(schema.phonemeScores).values(
              agreement.map((p, pIdx) => ({
                wordScoreId,
                idx: pIdx,
                phone: p.phone,
                mean: assertFinite(p.mean, `utterance ${uttId} word ${wIdx} phone ${pIdx} mean`),
                scores: p.scores,
                disagreement: p.disagreement,
                insertionsAfter: p.insertionsAfter,
              })),
            )
            phonemeScoreCount += agreement.length
          }
        }

        const expertRows = Array.from({ length: 5 }, (_, e) => ({
          utteranceId: uttId,
          expertIdx: e,
          accuracy: assertFinite(det.accuracy[e], `utterance ${uttId} expert ${e} accuracy`),
          fluency: assertFinite(det.fluency[e], `utterance ${uttId} expert ${e} fluency`),
          prosodic: assertFinite(det.prosodic[e], `utterance ${uttId} expert ${e} prosodic`),
          // Normalize scores-detail's 0-1 completeness to the same 0-10 scale as
          // every other score here (see the SCALE TRAP note above), so
          // expert_scores.completeness is directly comparable to
          // utterances.completeness instead of silently one order of magnitude off.
          completeness: assertFinite(det.completeness[e], `utterance ${uttId} expert ${e} completeness`) * 10,
        }))
        await db.insert(schema.expertScores).values(expertRows)
        expertScoreCount += expertRows.length
      }
    }
  }

  // ---- Convert only the selected utterances' audio ----
  console.log(`Converting ${audioNeeded.length} audio files to .${AUDIO_EXT} ...`)
  fs.mkdirSync(AUDIO_OUT, { recursive: true })
  let converted = 0
  for (const { uttId, srcWav } of audioNeeded) {
    if (!fs.existsSync(srcWav)) throw new Error(`Missing source wav for utterance ${uttId}: ${srcWav}`)
    const dest = path.join(AUDIO_OUT, `${uttId}.${AUDIO_EXT}`)
    if (AUDIO_EXT === "opus") {
      execFileSync("ffmpeg", ["-y", "-i", srcWav, "-c:a", "libopus", "-b:a", "24k", dest], { stdio: "ignore" })
    } else {
      execFileSync("ffmpeg", ["-y", "-i", srcWav, "-c:a", "libmp3lame", "-b:a", "32k", dest], { stdio: "ignore" })
    }
    converted++
    if (converted % 50 === 0) console.log(`  converted ${converted}/${audioNeeded.length}`)
  }

  const arcCounts = selected.reduce<Record<string, number>>((a, s) => {
    a[s.arc] = (a[s.arc] ?? 0) + 1
    return a
  }, {})
  const bandCounts = selected.reduce<Record<string, number>>((a, s) => {
    const b = bandForAccuracy(s.meanAccuracy)
    a[b] = (a[b] ?? 0) + 1
    return a
  }, {})

  console.log("\nSeed complete.")
  console.log(`  Org: Northwind Support (${ORG_ID})`)
  console.log(`  Cohort: Seoul Support Pilot — Cohort 1 (${COHORT_ID})`)
  console.log(`  Learners: ${selected.length}`)
  console.log(`  Sessions: ${sessionCount}`)
  console.log(`  Utterances: ${utteranceCount}`)
  console.log(`  Word scores: ${wordScoreCount}`)
  console.log(`  Phoneme scores: ${phonemeScoreCount}`)
  console.log(`  Expert scores: ${expertScoreCount}`)
  console.log(`  Audio files converted: ${converted} (.${AUDIO_EXT})`)
  console.log(`  Arc mix:`, arcCounts)
  console.log(`  Band distribution:`, bandCounts)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await sql.end()
  })
