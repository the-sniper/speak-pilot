import { z } from "zod"
import { BANDS } from "./bands"

// A bare CEFR-shaped token (e.g. "B2") is not, by itself, evidence of CEFR jargon —
// it also matches room numbers ("Room B2"), pay grades ("grade A1"), etc. So instead
// of flagging any occurrence of the token, we flag it only when it appears in a
// construction that actually asserts a proficiency level:
//   - the literal word "CEFR" anywhere,
//   - a band token near "level"/"proficiency" ("CEFR level B1", "B1 proficiency"),
//   - a target/movement verb directly governing a band token ("reach B2", "move to C1"),
//   - a "from <band> to <band>" transition ("from A2 to B1").
const BAND_TOKEN = "(?:A1|A2|B1|B2|C1|C2)"
const CEFR_WORD = /\bCEFR\b/i
const LEVEL_NEAR_BAND = new RegExp(
  `\\b(?:level|proficiency)\\b[\\s\\S]{0,20}\\b${BAND_TOKEN}\\b|\\b${BAND_TOKEN}\\b[\\s\\S]{0,20}\\b(?:level|proficiency)\\b`,
  "i",
)
const TARGET_VERB_TO_BAND = new RegExp(
  `\\b(?:reach|reaches|reaching|hit|hits|hitting|attain|attains|attaining|achieve|achieves|achieving|get(?:s|ting)?\\s+to|move(?:s|d)?\\s+to|advance(?:s|d)?\\s+to)\\s+(?:the\\s+)?${BAND_TOKEN}\\b`,
  "i",
)
const FROM_BAND_TO_BAND = new RegExp(`\\bfrom\\s+${BAND_TOKEN}\\s+to\\s+${BAND_TOKEN}\\b`, "i")

function containsCefrJargon(s: string): boolean {
  return (
    CEFR_WORD.test(s) ||
    LEVEL_NEAR_BAND.test(s) ||
    TARGET_VERB_TO_BAND.test(s) ||
    FROM_BAND_TO_BAND.test(s)
  )
}

// BANDS is a readonly tuple. Zod 3.20+ accepts readonly tuples in z.enum; if the
// installed Zod complains, widen with `z.enum([...BANDS] as [Band, ...Band[]])`.
export const Placement = z.object({
  learnerId: z.string(),
  band: z.enum(BANDS),
  rationale: z.string().max(280),
  evidenceUtteranceIds: z.array(z.string()).min(1),
})

export const Scenario = z.object({
  title: z.string(),
  situation: z.string(),
  targetPhrases: z.array(z.string()).min(3).max(8),
  successLooksLike: z.string(),
})

export const CohortSchema = z.object({
  size: z.number(), l1: z.string(), role: z.string(), horizonWeeks: z.number(),
  understanding: z.string(),          // the one-sentence restatement for the first card
})

export const SuccessCriterion = z.object({
  plainLanguage: z.string().refine(s => !containsCefrJargon(s), {
    message: "plainLanguage must not contain CEFR codes",
  }),
  measurableProxy: z.string(),
})

export const CurriculumSchema = z.object({
  weeks: z.array(z.object({
    n: z.number(), theme: z.string(), scenarios: z.array(Scenario).min(2).max(4),
  })),
  cadence: z.object({ sessionsPerWeek: z.number(), minutesPerSession: z.number() }),
  successCriteria: z.array(SuccessCriterion).min(2),
  kickoffMessage: z.object({ en: z.string(), ko: z.string() }),
})

export const ProgramSchema = z.object({
  cohort: CohortSchema,
  placements: z.array(Placement),
  weeks: CurriculumSchema.shape.weeks,
  cadence: CurriculumSchema.shape.cadence,
  successCriteria: CurriculumSchema.shape.successCriteria,
  kickoffMessage: CurriculumSchema.shape.kickoffMessage,
})

export const WeeklyPassSchema = z.object({
  weekNumber: z.number(),
  onTrack: z.array(z.string()),
  slipped: z.array(z.string()),
  atRisk: z.array(z.string()),
  managerBrief: z.string(),
  curriculumAdjustments: z.array(z.object({
    weekN: z.number(), change: z.string(), reason: z.string(),
  })),
  drafts: z.array(z.object({
    learnerId: z.string(), channel: z.enum(["email", "slack"]),
    subject: z.string(), body: z.string(), reason: z.string(),
  })),
})

export const QbrSchema = z.object({
  headline: z.string(),
  narrative: z.string(),
  wins: z.array(z.string()).min(1),
  risks: z.array(z.string()),
  recommendation: z.string(),
})

export type PlacementT = z.infer<typeof Placement>
export type ProgramT = z.infer<typeof ProgramSchema>
export type WeeklyPassT = z.infer<typeof WeeklyPassSchema>
export type QbrT = z.infer<typeof QbrSchema>
