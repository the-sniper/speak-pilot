import { z } from "zod"
import { BANDS } from "./bands"

const NO_CEFR = /\b(A1|A2|B1|B2|C1|C2|CEFR)\b/i

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
  // Deliberately over-rejects: any bare CEFR-shaped token (A1/A2/B1/B2/C1/C2) or the
  // word "CEFR" fails this field, even in incidental phrasing like "Room B2" or
  // "grade A1". In manager-facing prose about a language-training program, a
  // band-shaped token is far more likely to be a CEFR proficiency claim than a room
  // number, and enumerating every way a model can phrase a CEFR target ("everyone
  // should be B1", "aim for B1 by week 6", "target: C1", ...) is unbounded — a
  // narrower check that requires specific verbs or nearby keywords was tried and
  // leaked genuine jargon through untested phrasings. Between the two failure modes,
  // we accept the loud one: a false positive here is a rejected safeParse and a
  // retry. The one we refuse is silent: CEFR jargon reaching a manager who was
  // promised plain language, defeating the reason this field exists.
  plainLanguage: z.string().refine(s => !NO_CEFR.test(s), {
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
