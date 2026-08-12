import {
  pgTable, text, integer, real, boolean, timestamp, jsonb, serial,
} from "drizzle-orm/pg-core"

export const orgs = pgTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
})

export const cohorts = pgTable("cohorts", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => orgs.id),
  name: text("name").notNull(),
})

export const learners = pgTable("learners", {
  id: text("id").primaryKey(),
  cohortId: text("cohort_id").notNull().references(() => cohorts.id),
  speakerId: text("speaker_id").notNull(),        // real corpus speaker, e.g. "0006"
  name: text("name").notNull(),                    // fictional
  role: text("role").notNull(),                    // fictional
  arc: text("arc").notNull(),                      // strong|modest|plateau|declining|stopped
  expertMeanAccuracy: real("expert_mean_accuracy").notNull(),
  trueBand: text("true_band").notNull(),           // from bandForAccuracy, the eval ground truth
})

export const programs = pgTable("programs", {
  id: text("id").primaryKey(),
  cohortId: text("cohort_id").notNull().references(() => cohorts.id),
  brief: text("brief").notNull(),
  cohortSummary: jsonb("cohort_summary"),
  cadence: jsonb("cadence"),
  successCriteria: jsonb("success_criteria"),
  kickoff: jsonb("kickoff"),
  horizonWeeks: integer("horizon_weeks").notNull(),
  currentWeek: integer("current_week").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

export const programWeeks = pgTable("program_weeks", {
  id: text("id").primaryKey(),
  programId: text("program_id").notNull().references(() => programs.id),
  n: integer("n").notNull(),
  theme: text("theme").notNull(),
  managerBrief: text("manager_brief"),
  onTrack: jsonb("on_track"),
  slipped: jsonb("slipped"),
  atRisk: jsonb("at_risk"),
  adjustments: jsonb("adjustments"),
  advancedAt: timestamp("advanced_at"),
})

export const scenarios = pgTable("scenarios", {
  id: text("id").primaryKey(),
  weekId: text("week_id").notNull().references(() => programWeeks.id),
  title: text("title").notNull(),
  situation: text("situation").notNull(),
  targetPhrases: jsonb("target_phrases").notNull(),
  successLooksLike: text("success_looks_like").notNull(),
})

export const placements = pgTable("placements", {
  id: text("id").primaryKey(),
  programId: text("program_id").notNull().references(() => programs.id),
  learnerId: text("learner_id").notNull().references(() => learners.id),
  band: text("band").notNull(),                       // what the model said — immutable
  overriddenBand: text("overridden_band"),            // what a human said — nullable
  rationale: text("rationale").notNull(),
  evidenceUtteranceIds: jsonb("evidence_utterance_ids").notNull(),
})

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  learnerId: text("learner_id").notNull().references(() => learners.id),
  weekN: integer("week_n").notNull(),
  completed: boolean("completed").notNull().default(true),
})

export const utterances = pgTable("utterances", {
  id: text("id").primaryKey(),                        // real corpus utt id, e.g. "000010011"
  sessionId: text("session_id").notNull().references(() => sessions.id),
  learnerId: text("learner_id").notNull().references(() => learners.id),
  text: text("text").notNull(),
  audioPath: text("audio_path").notNull(),            // /audio/000010011.opus
  accuracy: real("accuracy").notNull(),
  fluency: real("fluency").notNull(),
  prosodic: real("prosodic").notNull(),
  completeness: real("completeness").notNull(),
  total: real("total").notNull(),
})

export const wordScores = pgTable("word_scores", {
  id: serial("id").primaryKey(),
  utteranceId: text("utterance_id").notNull().references(() => utterances.id),
  idx: integer("idx").notNull(),
  text: text("text").notNull(),
  accuracy: real("accuracy").notNull(),
  stress: real("stress").notNull(),
  total: real("total").notNull(),
  refPhones: text("ref_phones").notNull(),
})

export const phonemeScores = pgTable("phoneme_scores", {
  id: serial("id").primaryKey(),
  wordScoreId: integer("word_score_id").notNull().references(() => wordScores.id),
  idx: integer("idx").notNull(),
  phone: text("phone").notNull(),
  mean: real("mean").notNull(),                       // 0..2, mean across experts
  scores: jsonb("scores").notNull(),                  // (0|1|2)[] per expert
  disagreement: real("disagreement").notNull(),
  insertionsAfter: jsonb("insertions_after").notNull(),
})

export const expertScores = pgTable("expert_scores", {
  id: serial("id").primaryKey(),
  utteranceId: text("utterance_id").notNull().references(() => utterances.id),
  expertIdx: integer("expert_idx").notNull(),         // 0..4
  accuracy: real("accuracy").notNull(),
  fluency: real("fluency").notNull(),
  prosodic: real("prosodic").notNull(),
  completeness: real("completeness").notNull(),
})

export const agentRuns = pgTable("agent_runs", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),                       // cohort|placement|curriculum|weekly|qbr|judge
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  briefLabel: text("brief_label"),                    // which eval brief, if any
  input: jsonb("input").notNull(),
  output: jsonb("output"),
  ok: boolean("ok").notNull(),
  attempt: integer("attempt").notNull().default(1),   // 1 = first try, 2 = post-retry
  error: text("error"),
  cacheHit: boolean("cache_hit").notNull().default(false),
  latencyMs: integer("latency_ms").notNull(),
  cost: real("cost").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

export const drafts = pgTable("drafts", {
  id: text("id").primaryKey(),
  programId: text("program_id").notNull().references(() => programs.id),
  weekN: integer("week_n").notNull(),
  learnerId: text("learner_id").notNull().references(() => learners.id),
  channel: text("channel").notNull(),                 // email|slack
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("draft"),  // draft|approved — never "sent"
  editedBody: text("edited_body"),
})
