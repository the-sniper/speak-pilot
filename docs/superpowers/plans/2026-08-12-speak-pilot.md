# Speak Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working demo where an L&D admin types a one-line brief and watches a grounded, evidence-backed English training program stream into existence, then advances it week by week.

**Architecture:** Next.js App Router single repo. Postgres via Drizzle holds a fictional org seeded from the real speechocean762 corpus. A provider-agnostic LLM adapter forces Zod-derived tool schemas and logs every call to `agent_runs`, which is the sole data source for the Evals tab. Program generation is three sequential model calls streamed to the client as six SSE sections. Arithmetic lives in code; the model only writes prose and makes judgement calls.

**Tech Stack:** Next.js 15 (App Router, React 19), TypeScript, Tailwind, Drizzle ORM + postgres.js, Zod, Vitest, ffmpeg (opus conversion), OpenAI (via swappable adapter).

## Global Constraints

- **Source of truth:** `docs/speak-pilot-build-guide.md` is the primary spec; `docs/superpowers/specs/2026-08-12-speak-pilot-design.md` records approved deltas and **wins wherever they disagree**.
- **Database:** local Homebrew Postgres 15, trust auth. `DATABASE_URL=postgres://areefsyed@localhost:5432/speak_pilot`. Do **not** start Docker. `docker-compose.yml` still ships unchanged for fresh clones.
- **Dataset:** read-only at `../.speak-pilot-data/speechocean762/` (outside the repo). Never copy it in. Only ~240 `.opus` files enter `public/audio/`.
- **Band cutoffs, fixed and never tuned after seeing results:** A1 `< 5.5`, A2 `5.5–6.9`, B1 `7.0–7.9`, B2 `8.0–8.6`, C1 `> 8.6`, applied to the 5-expert mean sentence accuracy.
- **Placement metrics:** always report exact-band match *and* within-one-band. Never quote only the flattering one.
- **CEFR caveat:** band labels are pronunciation-derived proxies, not CEFR assessments. This caveat appears in the README and in the placement UI.
- **Honesty banner** (persistent, every screen, not a modal) — exact copy:
  > Northwind Support and its people are fictional. Every recording, score, and expert annotation is real human-annotated learner speech from speechocean762 (CC BY 4.0). The week-over-week trajectory is constructed — the dataset captures one session per speaker, so progress over time is simulated by ordering real utterances. Placement accuracy is measured against real expert consensus and is not simulated.
- **`simulated` inline marker** on every week-over-week chart and score-movement figure.
- **Never auto-send drafts.** No UI state may imply a message left the building.
- **`plainLanguage` fields must never contain CEFR codes.**
- **Arithmetic in code, prose in the model.** The model receives computed facts and is told to treat them as true.
- Commit after every task. Never commit `.env` or the dataset.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/db/schema.ts` | Drizzle table definitions, all 14 tables |
| `src/db/index.ts` | postgres.js client + drizzle instance |
| `src/lib/phonemes.ts` | Parse expert phone markup; compute per-phone agreement |
| `src/lib/bands.ts` | Band cutoffs, score→band, band distance |
| `src/lib/placement.ts` | Build compact grounded learner blocks for the prompt |
| `src/lib/schemas.ts` | All Zod schemas (Program, WeeklyPass, QBR) |
| `src/lib/llm/adapter.ts` | `callWithSchema`, retry, `agent_runs` logging |
| `src/lib/llm/providers/{openai,anthropic,mock}.ts` | One `Provider` implementation each |
| `src/lib/llm/cache.ts` | sha256 → JSON file cache, REPLAY enforcement |
| `src/lib/llm/prompts.ts` | Every prompt string, one file |
| `src/lib/weekly.ts` | Computes weekly facts in code (no model) |
| `src/lib/evals.ts` | Scoring functions over `agent_runs` |
| `scripts/seed.ts` | Cohort selection + DB seed + audio conversion |
| `scripts/run-evals.ts` | Runs the 20 briefs, writes results |
| `src/components/*` | One component per build-guide Step 4/5/7 card |

---

## Task 1: Scaffold, database connection, honesty banner

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`, `drizzle.config.ts`, `docker-compose.yml`, `.env.example`, `.env`, `vitest.config.ts`
- Create: `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`
- Create: `src/components/HonestyBanner.tsx`
- Create: `src/db/index.ts`
- Test: `src/components/HonestyBanner.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `db` (drizzle instance) from `src/db/index.ts`; `HONESTY_TEXT: string` and default-export `HonestyBanner` from `src/components/HonestyBanner.tsx`

- [ ] **Step 1: Scaffold the Next.js app in place**

The repo already contains `docs/` and `.git`, so scaffold into a temp dir and move files in (create-next-app refuses a non-empty dir).

```bash
cd /Users/areefsyed/Desktop/Code/Experiments
npx create-next-app@latest _scaffold --typescript --tailwind --app --src-dir --eslint --no-turbopack --use-npm --import-alias "@/*"
rsync -a --exclude .git _scaffold/ speak-pilot/
rm -rf _scaffold
cd speak-pilot
npm i drizzle-orm postgres zod
npm i -D drizzle-kit tsx vitest @types/pg
```

- [ ] **Step 2: Create the database**

```bash
createdb speak_pilot && psql -d speak_pilot -c 'select 1'
```
Expected: prints `1`. If `createdb` says the database exists, that is fine.

- [ ] **Step 3: Write `.env` and `.env.example`**

`.env.example` (committed):
```
DATABASE_URL=postgres://USER@localhost:5432/speak_pilot
LLM_PROVIDER=mock          # mock | openai | anthropic
LLM_API_KEY=
LLM_MODEL=gpt-5
REPLAY=0                   # 1 = cache only, never call the API
```

`.env` (gitignored, real values):
```
DATABASE_URL=postgres://areefsyed@localhost:5432/speak_pilot
LLM_PROVIDER=mock
LLM_API_KEY=
LLM_MODEL=gpt-5
REPLAY=0
```

- [ ] **Step 4: Write the DB client**

`src/db/index.ts`:
```ts
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema"

const url = process.env.DATABASE_URL
if (!url) throw new Error("DATABASE_URL is not set")

export const sql = postgres(url, { max: 5 })
export const db = drizzle(sql, { schema })
```

Note: `./schema` does not exist until Task 4. Create a temporary empty `src/db/schema.ts` containing `export {}` so this compiles; Task 4 replaces it.

- [ ] **Step 5: Write the failing banner test**

`src/components/HonestyBanner.test.ts`:
```ts
import { describe, it, expect } from "vitest"
import { HONESTY_TEXT } from "./HonestyBanner"

describe("honesty banner copy", () => {
  it("names the corpus and its licence", () => {
    expect(HONESTY_TEXT).toContain("speechocean762")
    expect(HONESTY_TEXT).toContain("CC BY 4.0")
  })

  it("discloses that the trajectory is constructed", () => {
    expect(HONESTY_TEXT).toContain("constructed")
    expect(HONESTY_TEXT).toContain("simulated by ordering real utterances")
  })

  it("states that placement accuracy is NOT simulated", () => {
    expect(HONESTY_TEXT).toMatch(/measured against real expert consensus and is not simulated/)
  })

  it("marks the org as fictional", () => {
    expect(HONESTY_TEXT).toContain("fictional")
  })
})
```

`vitest.config.ts` — note the `@/*` alias must be mirrored here or every test importing `@/db` fails to resolve:
```ts
import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    setupFiles: ["dotenv/config"],          // tests need DATABASE_URL
  },
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
})
```

Also `npm i -D dotenv`.

Add to `package.json` scripts: `"test": "vitest run"`, `"db:push": "drizzle-kit push"`, `"seed": "tsx scripts/seed.ts"`, `"evals": "tsx scripts/run-evals.ts"`.

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run src/components/HonestyBanner.test.ts`
Expected: FAIL — cannot resolve `./HonestyBanner`.

- [ ] **Step 7: Implement the banner**

`src/components/HonestyBanner.tsx`:
```tsx
export const HONESTY_TEXT =
  "Northwind Support and its people are fictional. Every recording, score, and expert " +
  "annotation is real human-annotated learner speech from speechocean762 (CC BY 4.0). " +
  "The week-over-week trajectory is constructed — the dataset captures one session per " +
  "speaker, so progress over time is simulated by ordering real utterances. Placement " +
  "accuracy is measured against real expert consensus and is not simulated."

export default function HonestyBanner() {
  return (
    <div className="border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-[11px] leading-relaxed text-neutral-600">
      {HONESTY_TEXT}
    </div>
  )
}
```

Render it in `src/app/layout.tsx` directly inside `<body>`, above `{children}`, so it is present on every route.

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run src/components/HonestyBanner.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 9: Verify the app boots**

Run: `npm run dev` then `curl -s localhost:3000 | grep -c speechocean762`
Expected: `1` or more. Stop the dev server.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat: scaffold Next.js app with honesty banner and DB client"
```

---

## Task 2: Phone markup parser

The single trickiest piece of data handling in the project, and the foundation of the evidence panel. Pure functions, no I/O.

**Files:**
- Create: `src/lib/phonemes.ts`
- Test: `src/lib/phonemes.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  ```ts
  export type PhoneToken = { phone: string; score: 0 | 1 | 2 | null; inserted: boolean }
  export function parsePhoneMarkup(expertPhones: string): PhoneToken[]

  export type PhoneAgreement = {
    phone: string                  // the reference phone, e.g. "EH0"
    scores: (0 | 1 | 2)[]          // one per expert, in expert order
    mean: number                   // mean of scores, 0..2
    disagreement: number           // max(scores) - min(scores)
    insertionsAfter: string[]      // phones experts inserted after this position
  }
  export function phoneAgreement(refPhones: string, expertPhones: string[]): PhoneAgreement[]
  ```

- [ ] **Step 1: Write the failing tests**

These come from the dataset README's own worked examples plus a real row from `scores-detail.json`, so they encode the vendor's semantics rather than our guess.

`src/lib/phonemes.test.ts`:
```ts
import { describe, it, expect } from "vitest"
import { parsePhoneMarkup, phoneAgreement } from "./phonemes"

describe("parsePhoneMarkup", () => {
  it("scores bare phones as 2", () => {
    expect(parsePhoneMarkup("W IY0")).toEqual([
      { phone: "W", score: 2, inserted: false },
      { phone: "IY0", score: 2, inserted: false },
    ])
  })

  it("scores {X} as 1 (accented)", () => {
    expect(parsePhoneMarkup("K {AO0} L")).toEqual([
      { phone: "K", score: 2, inserted: false },
      { phone: "AO0", score: 1, inserted: false },
      { phone: "L", score: 2, inserted: false },
    ])
  })

  it("scores (X) as 0 (wrong or missed), per the README's 'B (EH) R' example", () => {
    expect(parsePhoneMarkup("B (EH) R")).toEqual([
      { phone: "B", score: 2, inserted: false },
      { phone: "EH", score: 0, inserted: false },
      { phone: "R", score: 2, inserted: false },
    ])
  })

  it("marks [X] as an insertion with no score, per 'B EH [L] R'", () => {
    expect(parsePhoneMarkup("B EH [L] R")).toEqual([
      { phone: "B", score: 2, inserted: false },
      { phone: "EH", score: 2, inserted: false },
      { phone: "L", score: null, inserted: true },
      { phone: "R", score: 2, inserted: false },
    ])
  })

  it("handles multiple markups in one string", () => {
    expect(parsePhoneMarkup("B (EH0) (R)")).toEqual([
      { phone: "B", score: 2, inserted: false },
      { phone: "EH0", score: 0, inserted: false },
      { phone: "R", score: 0, inserted: false },
    ])
  })

  it("tolerates extra whitespace", () => {
    expect(parsePhoneMarkup("  B   EH0  ")).toHaveLength(2)
  })
})

describe("phoneAgreement", () => {
  // The real BEAR row from utterance 000010011 in scores-detail.json.
  const ref = "B EH0 R"
  const experts = ["B (EH0) (R)", "B {EH0} {R}", "B EH0 R", "B (EH0) (R)", "B EH0 [L] R"]

  it("returns one entry per reference phone, ignoring insertions", () => {
    const out = phoneAgreement(ref, experts)
    expect(out.map(p => p.phone)).toEqual(["B", "EH0", "R"])
  })

  it("collects every expert's score for a phone in order", () => {
    const out = phoneAgreement(ref, experts)
    expect(out[1].scores).toEqual([0, 1, 2, 0, 2])   // EH0
  })

  it("computes the mean across experts", () => {
    const out = phoneAgreement(ref, experts)
    expect(out[1].mean).toBeCloseTo(1.0, 5)          // (0+1+2+0+2)/5
  })

  it("reports disagreement as the score range", () => {
    const out = phoneAgreement(ref, experts)
    expect(out[1].disagreement).toBe(2)              // max 2, min 0
    expect(out[0].disagreement).toBe(0)              // B: everyone said 2
  })

  it("attributes an inserted phone to the position it follows", () => {
    const out = phoneAgreement(ref, experts)
    expect(out[1].insertionsAfter).toEqual(["L"])    // expert 5's intrusive L, after EH0
  })

  it("agrees with the aggregated means in scores.json for this row", () => {
    // scores.json phones-accuracy for BEAR is [2.0, 1.0, 1.0]; our EH0 mean is 1.0.
    const out = phoneAgreement(ref, experts)
    expect(out[0].mean).toBeCloseTo(2.0, 5)
    expect(out[1].mean).toBeCloseTo(1.0, 5)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/phonemes.test.ts`
Expected: FAIL — cannot resolve `./phonemes`.

- [ ] **Step 3: Implement the parser**

`src/lib/phonemes.ts`:
```ts
export type PhoneToken = { phone: string; score: 0 | 1 | 2 | null; inserted: boolean }

/**
 * speechocean762 notates per-expert phone verdicts inline against the reference:
 *   bare  -> 2 (correct)     {X} -> 1 (accented)
 *   (X)   -> 0 (wrong/missed) [X] -> inserted phone, unscored
 */
export function parsePhoneMarkup(expertPhones: string): PhoneToken[] {
  return expertPhones
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      const m = /^([({[])(.+)[)}\]]$/.exec(tok)
      if (!m) return { phone: tok, score: 2 as const, inserted: false }
      const [, open, phone] = m
      if (open === "{") return { phone, score: 1 as const, inserted: false }
      if (open === "(") return { phone, score: 0 as const, inserted: false }
      return { phone, score: null, inserted: true }
    })
}

export type PhoneAgreement = {
  phone: string
  scores: (0 | 1 | 2)[]
  mean: number
  disagreement: number
  insertionsAfter: string[]
}

/**
 * Aligns every expert's markup to the reference phone sequence.
 * Insertions do not consume a reference position; they are attributed to the
 * preceding reference phone (index -1 means "before the first phone").
 */
export function phoneAgreement(refPhones: string, expertPhones: string[]): PhoneAgreement[] {
  const ref = refPhones.trim().split(/\s+/).filter(Boolean)
  const out: PhoneAgreement[] = ref.map((phone) => ({
    phone, scores: [], mean: 0, disagreement: 0, insertionsAfter: [],
  }))

  for (const markup of expertPhones) {
    let i = 0
    for (const tok of parsePhoneMarkup(markup)) {
      if (tok.inserted) {
        const at = Math.min(Math.max(i - 1, 0), out.length - 1)
        if (out[at]) out[at].insertionsAfter.push(tok.phone)
        continue
      }
      if (i < out.length && tok.score !== null) out[i].scores.push(tok.score)
      i++
    }
  }

  for (const p of out) {
    p.mean = p.scores.length ? p.scores.reduce((a, b) => a + b, 0) / p.scores.length : 0
    p.disagreement = p.scores.length ? Math.max(...p.scores) - Math.min(...p.scores) : 0
  }
  return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/phonemes.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Validate the parser against the whole corpus**

A unit test proves the README's examples. This proves the parser survives all 5,000 utterances — catching notation we have not seen.

```bash
npx tsx -e '
import { parsePhoneMarkup, phoneAgreement } from "./src/lib/phonemes"
import fs from "fs"
const D = "../.speak-pilot-data/speechocean762/resource"
const detail = JSON.parse(fs.readFileSync(`${D}/scores-detail.json`, "utf8"))
const agg = JSON.parse(fs.readFileSync(`${D}/scores.json`, "utf8"))
let words = 0, mismatch = 0, unparsed = 0, maxDelta = 0
for (const [uid, u] of Object.entries<any>(detail)) {
  const aggWords = agg[uid]?.words ?? []
  u.words.forEach((w: any, wi: number) => {
    words++
    for (const m of w.phones) for (const t of parsePhoneMarkup(m)) if (!/^[A-Z]+[0-9]?$/.test(t.phone)) unparsed++
    const ours = phoneAgreement(w["ref-phones"], w.phones)
    const theirs = aggWords[wi]?.["phones-accuracy"] ?? []
    if (ours.length !== theirs.length) { mismatch++; return }
    ours.forEach((p, i) => { maxDelta = Math.max(maxDelta, Math.abs(p.mean - theirs[i])) })
  })
}
console.log({ words, unparsed, lengthMismatch: mismatch, maxMeanDelta: maxDelta.toFixed(4) })
'
```

Expected: `unparsed: 0` and `lengthMismatch: 0`. `maxMeanDelta` should be at or near 0 — our recomputed means should reproduce `scores.json`'s published `phones-accuracy`.

**If `maxMeanDelta` is large or `lengthMismatch` is non-zero, stop and investigate before continuing.** It means the alignment assumption is wrong, and every downstream evidence claim would inherit the error. Record the finding, fix the parser, and re-run. Do not paper over it by loosening the check.

- [ ] **Step 6: Commit**

```bash
git add src/lib/phonemes.ts src/lib/phonemes.test.ts
git commit -m "feat: parse per-expert phone markup with corpus-wide validation"
```

---

## Task 3: Band mapping

**Files:**
- Create: `src/lib/bands.ts`
- Test: `src/lib/bands.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  ```ts
  export const BANDS = ["A1", "A2", "B1", "B2", "C1"] as const
  export type Band = (typeof BANDS)[number]
  export function bandForAccuracy(meanExpertAccuracy: number): Band
  export function bandDistance(a: Band, b: Band): number
  export const BAND_TABLE: { band: Band; min: number; max: number }[]
  ```

- [ ] **Step 1: Write the failing tests**

`src/lib/bands.test.ts`:
```ts
import { describe, it, expect } from "vitest"
import { bandForAccuracy, bandDistance, BANDS } from "./bands"

describe("bandForAccuracy — cutoffs are fixed and must never be tuned to results", () => {
  it("maps the documented ranges", () => {
    expect(bandForAccuracy(3.93)).toBe("A1")   // corpus minimum
    expect(bandForAccuracy(5.49)).toBe("A1")
    expect(bandForAccuracy(5.5)).toBe("A2")
    expect(bandForAccuracy(6.9)).toBe("A2")
    expect(bandForAccuracy(7.0)).toBe("B1")
    expect(bandForAccuracy(7.99)).toBe("B1")
    expect(bandForAccuracy(8.0)).toBe("B2")
    expect(bandForAccuracy(8.6)).toBe("B2")
    expect(bandForAccuracy(8.61)).toBe("C1")
    expect(bandForAccuracy(9.31)).toBe("C1")   // corpus maximum
  })

  it("covers the full 0-10 range without gaps", () => {
    for (let x = 0; x <= 10; x += 0.05) {
      expect(BANDS).toContain(bandForAccuracy(x))
    }
  })
})

describe("bandDistance", () => {
  it("is zero for an exact match", () => {
    expect(bandDistance("B1", "B1")).toBe(0)
  })
  it("counts steps along the ladder, unsigned", () => {
    expect(bandDistance("A1", "A2")).toBe(1)
    expect(bandDistance("C1", "B2")).toBe(1)
    expect(bandDistance("A1", "C1")).toBe(4)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/bands.test.ts`
Expected: FAIL — cannot resolve `./bands`.

- [ ] **Step 3: Implement**

`src/lib/bands.ts`:
```ts
export const BANDS = ["A1", "A2", "B1", "B2", "C1"] as const
export type Band = (typeof BANDS)[number]

/**
 * Fixed, published before the first eval run. Derived from the speaker-level
 * 5-expert mean accuracy distribution across all 250 corpus speakers.
 * These are pronunciation-derived proxies, NOT CEFR assessments.
 */
export const BAND_TABLE: { band: Band; min: number; max: number }[] = [
  { band: "A1", min: -Infinity, max: 5.5 },
  { band: "A2", min: 5.5, max: 7.0 },
  { band: "B1", min: 7.0, max: 8.0 },
  { band: "B2", min: 8.0, max: 8.6 },
  { band: "C1", min: 8.6, max: Infinity },
]

export function bandForAccuracy(meanExpertAccuracy: number): Band {
  // Upper bound exclusive except B2, whose 8.6 boundary is inclusive per the table.
  for (const row of BAND_TABLE) {
    if (row.band === "B2" ? meanExpertAccuracy <= row.max : meanExpertAccuracy < row.max) {
      if (meanExpertAccuracy >= row.min) return row.band
    }
  }
  return "C1"
}

export function bandDistance(a: Band, b: Band): number {
  return Math.abs(BANDS.indexOf(a) - BANDS.indexOf(b))
}
```

- [ ] **Step 4: Run to verify passage**

Run: `npx vitest run src/lib/bands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/bands.ts src/lib/bands.test.ts
git commit -m "feat: fixed band cutoffs with exact and within-one distance"
```

---

## Task 4: Database schema

**Files:**
- Modify: `src/db/schema.ts` (replaces the `export {}` stub from Task 1)
- Create: `drizzle.config.ts`

**Interfaces:**
- Consumes: nothing
- Produces: Drizzle tables `orgs, cohorts, learners, programs, programWeeks, scenarios, placements, sessions, utterances, wordScores, phonemeScores, expertScores, agentRuns, drafts`

- [ ] **Step 1: Write `drizzle.config.ts`**

```ts
import type { Config } from "drizzle-kit"
export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
} satisfies Config
```

- [ ] **Step 2: Write the schema**

`src/db/schema.ts`. Key decisions, per the build guide §1e:
- `placements.overriddenBand` is **separate from** `placements.band`. Never overwrite what the model said.
- `agentRuns` carries `input`, `output`, `latencyMs`, `cost`, `ok`. Every LLM call writes a row, successes and failures alike. The Evals tab is a query over this table.

```ts
import {
  pgTable, text, integer, real, boolean, timestamp, jsonb, serial, primaryKey,
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
```

- [ ] **Step 3: Push the schema**

Run: `npm run db:push`
Expected: drizzle-kit reports the tables created.

- [ ] **Step 4: Verify the tables exist**

Run: `psql -d speak_pilot -c '\dt' | wc -l`
Expected: at least 14 table rows listed.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts drizzle.config.ts && git commit -m "feat: database schema with band override and agent_runs audit trail"
```

---

## Task 5: Seed script

The task with the most real-data contact. Selects the cohort, converts audio, and loads every score level.

**Files:**
- Create: `scripts/seed.ts`
- Create: `scripts/select-cohort.ts`
- Test: `scripts/select-cohort.test.ts`

**Interfaces:**
- Consumes: `bandForAccuracy` (Task 3), `phoneAgreement` (Task 2), all tables (Task 4)
- Produces:
  ```ts
  export type Arc = "strong" | "modest" | "plateau" | "declining" | "stopped"
  export type Selected = { speakerId: string; arc: Arc; meanAccuracy: number; utteranceIds: string[] }
  export function selectCohort(corpus: SpeakerStats[], seed: number): Selected[]
  export function weekPlan(utteranceCount: number, horizonWeeks: number): number[]
  ```

- [ ] **Step 1: Write the failing tests**

`scripts/select-cohort.test.ts`:
```ts
import { describe, it, expect } from "vitest"
import { selectCohort, weekPlan } from "./select-cohort"
import { bandForAccuracy } from "../src/lib/bands"

const corpus = Array.from({ length: 250 }, (_, i) => ({
  speakerId: String(i).padStart(4, "0"),
  meanAccuracy: 3.9 + (i / 249) * 5.4,          // spans the real 3.93..9.31 range
  utteranceTotals: Array.from({ length: 20 }, (_, j) => 4 + ((i + j) % 7)),
  utteranceIds: Array.from({ length: 20 }, (_, j) => `u${i}_${j}`),
}))

describe("weekPlan — distributes 20 utterances without overflowing", () => {
  it("gives 2 per week across a 10-week horizon", () => {
    expect(weekPlan(20, 10)).toEqual(Array(10).fill(2))
  })
  it("never assigns more than 20 utterances in total", () => {
    for (const n of [4, 6, 8, 10, 12, 16]) {
      expect(weekPlan(20, n).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(20)
    }
  })
  it("caps at 3 sessions per week on a short horizon", () => {
    expect(Math.max(...weekPlan(20, 4))).toBeLessThanOrEqual(3)
  })
  it("gives every week at least one session on a long horizon", () => {
    expect(Math.min(...weekPlan(20, 16))).toBeGreaterThanOrEqual(1)
    expect(weekPlan(20, 16)).toHaveLength(16)
  })
})

describe("selectCohort", () => {
  it("selects exactly 24 learners", () => {
    expect(selectCohort(corpus, 42)).toHaveLength(24)
  })

  it("matches the required arc mix", () => {
    const counts = selectCohort(corpus, 42).reduce<Record<string, number>>((a, s) => {
      a[s.arc] = (a[s.arc] ?? 0) + 1
      return a
    }, {})
    expect(counts).toEqual({ strong: 4, modest: 12, plateau: 5, declining: 2, stopped: 1 })
  })

  it("is deterministic for a fixed seed", () => {
    expect(selectCohort(corpus, 42)).toEqual(selectCohort(corpus, 42))
  })

  it("never selects the same speaker twice", () => {
    const ids = selectCohort(corpus, 42).map(s => s.speakerId)
    expect(new Set(ids).size).toBe(24)
  })

  it("spans at least four bands so the demo is not one flat block", () => {
    const bands = new Set(selectCohort(corpus, 42).map(s => bandForAccuracy(s.meanAccuracy)))
    expect(bands.size).toBeGreaterThanOrEqual(4)
  })

  it("gives the stopped learner fewer utterances than the others", () => {
    const out = selectCohort(corpus, 42)
    const stopped = out.find(s => s.arc === "stopped")!
    const normal = out.find(s => s.arc === "modest")!
    expect(stopped.utteranceIds.length).toBeLessThan(normal.utteranceIds.length)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run scripts/select-cohort.test.ts`
Expected: FAIL — cannot resolve `./select-cohort`.

Note: add `scripts/**/*.test.ts` to `vitest.config.ts`'s `include` array.

- [ ] **Step 3: Implement cohort selection**

`scripts/select-cohort.ts`:
```ts
import { bandForAccuracy } from "../src/lib/bands"

export type Arc = "strong" | "modest" | "plateau" | "declining" | "stopped"
export type SpeakerStats = {
  speakerId: string
  meanAccuracy: number
  utteranceTotals: number[]
  utteranceIds: string[]
}
export type Selected = {
  speakerId: string; arc: Arc; meanAccuracy: number; utteranceIds: string[]
}

const ARC_MIX: [Arc, number][] = [
  ["strong", 4], ["modest", 12], ["plateau", 5], ["declining", 2], ["stopped", 1],
]

/** Deterministic PRNG so seeding is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const spread = (s: SpeakerStats) =>
  Math.max(...s.utteranceTotals) - Math.min(...s.utteranceTotals)

/**
 * Selects 24 speakers satisfying two constraints at once:
 *  - arc mix (build guide 1c), driven by each speaker's real score spread
 *  - band spread, so the cohort is not 24 identical B2 cards
 * The cohort is curated; the band function it is graded against is not.
 */
export function selectCohort(corpus: SpeakerStats[], seed: number): Selected[] {
  const rand = mulberry32(seed)
  const taken = new Set<string>()
  const out: Selected[] = []

  // Wide spread suits improvement/decline arcs; tight spread suits plateau.
  const byWidest = [...corpus].sort((a, b) => spread(b) - spread(a) || a.speakerId.localeCompare(b.speakerId))
  const byTightest = [...byWidest].reverse()

  const pick = (pool: SpeakerStats[], arc: Arc, wantBand?: string) => {
    for (const s of pool) {
      if (taken.has(s.speakerId)) continue
      if (wantBand && bandForAccuracy(s.meanAccuracy) !== wantBand) continue
      taken.add(s.speakerId)
      const ordered = orderUtterances(s, arc)
      out.push({ speakerId: s.speakerId, arc, meanAccuracy: s.meanAccuracy, utteranceIds: ordered })
      return true
    }
    return false
  }

  // Seed one learner per band first so all five bands are represented.
  for (const band of ["A1", "A2", "B1", "B2", "C1"]) {
    pick(byWidest, "modest", band)
  }

  const remaining: [Arc, number][] = ARC_MIX.map(([arc, n]) =>
    [arc, arc === "modest" ? n - out.filter(o => o.arc === "modest").length : n])

  for (const [arc, n] of remaining) {
    const pool = arc === "plateau" ? byTightest : byWidest
    for (let i = 0; i < n; i++) {
      if (!pick(pool, arc)) pick(corpus.filter(c => !taken.has(c.speakerId)), arc)
    }
  }

  // Stable order, jittered by the seeded PRNG so it is not sorted-looking.
  return out.map(o => ({ o, k: rand() })).sort((a, b) => a.k - b.k).map(x => x.o)
}

/**
 * Orders a speaker's real utterances to express the arc.
 * NOTE: this constructs a trajectory. The corpus has no time dimension —
 * every utterance was recorded in one sitting. Disclosed in the honesty banner.
 */
function orderUtterances(s: SpeakerStats, arc: Arc): string[] {
  const paired = s.utteranceIds.map((id, i) => ({ id, total: s.utteranceTotals[i] }))
  const asc = [...paired].sort((a, b) => a.total - b.total).map(p => p.id)
  switch (arc) {
    case "strong":
    case "modest":   return asc
    case "declining": return [...asc].reverse()
    case "plateau":  return paired.map(p => p.id)             // leave in corpus order
    case "stopped":  return asc.slice(0, Math.ceil(asc.length * 0.5))
  }
}

/** Distributes utterances across the horizon; base capped at 3, remainder spread. */
export function weekPlan(utteranceCount: number, horizonWeeks: number): number[] {
  const base = Math.min(Math.floor(utteranceCount / horizonWeeks), 3)
  const rem = base < 3 ? utteranceCount - base * horizonWeeks : 0
  return Array.from({ length: horizonWeeks }, (_, i) =>
    Math.max(1, base + (i < rem ? 1 : 0)))
}
```

- [ ] **Step 4: Run to verify passage**

Run: `npx vitest run scripts/select-cohort.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Write the seed script**

`scripts/seed.ts` responsibilities, in order:
1. Read `resource/scores.json`, `resource/scores-detail.json`, and both `utt2spk` files from `../.speak-pilot-data/speechocean762/`.
2. Build `SpeakerStats[]` — per speaker, the 5-expert mean accuracy (mean over utterances of the mean over experts) and per-utterance totals.
3. `selectCohort(stats, 42)`.
4. Insert org `Northwind Support`, one cohort, 24 learners with fictional names and support-team roles. Set `expertMeanAccuracy` and `trueBand = bandForAccuracy(...)`.
5. For each learner, `weekPlan(ids.length, 10)` assigns utterances to weeks; insert a `sessions` row per week and `utterances` rows beneath it. For `arc === "stopped"`, mark the final weeks' sessions `completed: false`.
6. Per utterance insert `wordScores`, then `phonemeScores` from `phoneAgreement(refPhones, expertPhones)`, then five `expertScores` rows.
7. Convert only the selected wavs to opus into `public/audio/`.

Fictional names must not be derived from the corpus's real `spk2age`/`spk2gender`. Personas are independent fiction.

Audio conversion, inside the script via `child_process.execFileSync`:
```ts
execFileSync("ffmpeg", ["-y", "-i", srcWav, "-c:a", "libopus", "-b:a", "24k", destOpus], { stdio: "ignore" })
```

- [ ] **Step 6: Run the seed**

Run: `npm run seed`
Expected: completes without error and prints a summary.

- [ ] **Step 7: Verify the seed meets the build guide's "done when"**

The build guide's bar is: a select on a learner returns their utterances, word scores, phoneme scores, and all five expert scores.

```bash
psql -d speak_pilot -c "
select l.name, l.arc, l.true_band,
       count(distinct u.id) utts,
       count(distinct w.id) words,
       count(distinct p.id) phones,
       count(distinct e.id) experts
from learners l
join utterances u   on u.learner_id = l.id
join word_scores w  on w.utterance_id = u.id
join phoneme_scores p on p.word_score_id = w.id
join expert_scores e  on e.utterance_id = u.id
group by 1,2,3 order by 3,1;"
```
Expected: 24 rows, every count non-zero, `experts` exactly 5× the utterance count.

```bash
ls public/audio/*.opus | wc -l && du -sh public/audio/
```
Expected: roughly 200–300 files, comfortably under 10MB.

```bash
psql -d speak_pilot -c "select true_band, count(*) from learners group by 1 order by 1;"
```
Expected: at least four distinct bands populated.

- [ ] **Step 8: Commit**

```bash
git add scripts/ public/audio && git commit -m "feat: seed 24-learner cohort from real speechocean762 scores and audio"
```

---

## Task 6: Zod schemas

**Files:**
- Create: `src/lib/schemas.ts`
- Test: `src/lib/schemas.test.ts`

**Interfaces:**
- Consumes: `BANDS` (Task 3)
- Produces: `Placement`, `Scenario`, `ProgramSchema`, `CohortSchema`, `CurriculumSchema`, `WeeklyPassSchema`, `QbrSchema`, and their inferred TS types

- [ ] **Step 1: Write the failing tests**

`src/lib/schemas.test.ts`:
```ts
import { describe, it, expect } from "vitest"
import { Placement, ProgramSchema, WeeklyPassSchema, Scenario } from "./schemas"

const validPlacement = {
  learnerId: "l1", band: "B1", rationale: "Consistent vowel substitution under load.",
  evidenceUtteranceIds: ["000010011"],
}

describe("Placement", () => {
  it("accepts a grounded placement", () => {
    expect(Placement.safeParse(validPlacement).success).toBe(true)
  })

  it("REJECTS a placement citing no evidence — the point of the schema", () => {
    const r = Placement.safeParse({ ...validPlacement, evidenceUtteranceIds: [] })
    expect(r.success).toBe(false)
  })

  it("rejects an unknown band", () => {
    expect(Placement.safeParse({ ...validPlacement, band: "D9" }).success).toBe(false)
  })

  it("rejects a rationale over 280 chars", () => {
    expect(Placement.safeParse({ ...validPlacement, rationale: "x".repeat(281) }).success).toBe(false)
  })
})

describe("Scenario", () => {
  it("requires between 3 and 8 target phrases", () => {
    const base = { title: "t", situation: "s", successLooksLike: "ok" }
    expect(Scenario.safeParse({ ...base, targetPhrases: ["a", "b"] }).success).toBe(false)
    expect(Scenario.safeParse({ ...base, targetPhrases: ["a", "b", "c"] }).success).toBe(true)
    expect(Scenario.safeParse({ ...base, targetPhrases: Array(9).fill("a") }).success).toBe(false)
  })
})

describe("WeeklyPassSchema", () => {
  it("requires every draft to state its triggering fact", () => {
    const draft = { learnerId: "l1", channel: "email", subject: "s", body: "b" }
    const pass = {
      weekNumber: 1, onTrack: [], slipped: [], atRisk: [], managerBrief: "ok",
      curriculumAdjustments: [], drafts: [draft],
    }
    expect(WeeklyPassSchema.safeParse(pass).success).toBe(false)          // no reason
    pass.drafts = [{ ...draft, reason: "Missed both week-1 sessions." }] as any
    expect(WeeklyPassSchema.safeParse(pass).success).toBe(true)
  })

  it("rejects a channel other than email or slack", () => {
    const pass = {
      weekNumber: 1, onTrack: [], slipped: [], atRisk: [], managerBrief: "ok",
      curriculumAdjustments: [],
      drafts: [{ learnerId: "l1", channel: "sms", subject: "s", body: "b", reason: "r" }],
    }
    expect(WeeklyPassSchema.safeParse(pass).success).toBe(false)
  })
})

describe("ProgramSchema successCriteria", () => {
  it("rejects CEFR codes in plainLanguage — managers do not speak CEFR", () => {
    const crit = { plainLanguage: "Reach B2 on escalation calls", measurableProxy: "x" }
    const r = ProgramSchema.shape.successCriteria.safeParse([crit, crit])
    expect(r.success).toBe(false)
  })

  it("accepts plain-language criteria", () => {
    const crit = {
      plainLanguage: "Handles an angry caller without switching to Korean",
      measurableProxy: "Completes 3 escalation scenarios with accuracy at or above 7",
    }
    expect(ProgramSchema.shape.successCriteria.safeParse([crit, crit]).success).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/schemas.test.ts`
Expected: FAIL — cannot resolve `./schemas`.

- [ ] **Step 3: Implement**

`src/lib/schemas.ts` — as the build guide §2c specifies, plus the CEFR guard the tests require. Split `ProgramSchema` into the three call-sized pieces the SSE route needs.

```ts
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
```

- [ ] **Step 4: Run to verify passage**

Run: `npx vitest run src/lib/schemas.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/schemas.ts src/lib/schemas.test.ts && git commit -m "feat: Zod schemas enforcing grounded evidence and jargon-free criteria"
```

---

## Task 7: LLM adapter, cache, and mock provider

**Files:**
- Create: `src/lib/llm/adapter.ts`, `src/lib/llm/cache.ts`, `src/lib/llm/prompts.ts`
- Create: `src/lib/llm/providers/{types,openai,anthropic,mock}.ts`
- Test: `src/lib/llm/cache.test.ts`, `src/lib/llm/adapter.test.ts`

**Interfaces:**
- Consumes: `agentRuns` table (Task 4), all schemas (Task 6)
- Produces:
  ```ts
  export type Provider = {
    name: string
    call(args: { system: string; prompt: string; toolName: string; jsonSchema: object; model: string }):
      Promise<{ raw: unknown; cost: number }>
  }
  export function callWithSchema<T>(args: {
    prompt: string; system: string; schema: z.ZodType<T>; toolName: string
    kind: string; briefLabel?: string; maxRetries?: number
  }): Promise<{ data: T; runId: string; latencyMs: number; cost: number; cacheHit: boolean }>
  export function cacheKey(system: string, prompt: string, toolName: string, model: string): string
  ```

- [ ] **Step 1: Write the failing cache tests**

`src/lib/llm/cache.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import { cacheKey, readCache, writeCache, CacheMissInReplayError } from "./cache"

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmcache-")) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); delete process.env.REPLAY })

describe("cacheKey", () => {
  it("is stable for identical inputs", () => {
    expect(cacheKey("s", "p", "t", "m")).toBe(cacheKey("s", "p", "t", "m"))
  })
  it("changes when any component changes", () => {
    const base = cacheKey("s", "p", "t", "m")
    expect(cacheKey("s2", "p", "t", "m")).not.toBe(base)
    expect(cacheKey("s", "p2", "t", "m")).not.toBe(base)
    expect(cacheKey("s", "p", "t2", "m")).not.toBe(base)
    expect(cacheKey("s", "p", "t", "m2")).not.toBe(base)
  })
})

describe("cache round-trip", () => {
  it("returns null on a miss when not replaying", () => {
    expect(readCache(dir, "nope")).toBeNull()
  })
  it("returns what was written", () => {
    writeCache(dir, "k1", { hello: "world" })
    expect(readCache(dir, "k1")).toEqual({ hello: "world" })
  })
  it("THROWS on a miss when REPLAY=1 — the deployed link must never call the API", () => {
    process.env.REPLAY = "1"
    expect(() => readCache(dir, "missing")).toThrow(CacheMissInReplayError)
  })
  it("still serves hits when REPLAY=1", () => {
    writeCache(dir, "k2", { ok: true })
    process.env.REPLAY = "1"
    expect(readCache(dir, "k2")).toEqual({ ok: true })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/llm/cache.test.ts`
Expected: FAIL — cannot resolve `./cache`.

- [ ] **Step 3: Implement the cache**

`src/lib/llm/cache.ts`:
```ts
import crypto from "crypto"
import fs from "fs"
import path from "path"

export class CacheMissInReplayError extends Error {
  constructor(key: string) {
    super(`REPLAY=1 but no cached response for ${key}. Run once with a real provider first.`)
    this.name = "CacheMissInReplayError"
  }
}

export const CACHE_DIR = path.join(process.cwd(), ".llm-cache")

export function cacheKey(system: string, prompt: string, toolName: string, model: string): string {
  return crypto.createHash("sha256")
    .update([system, prompt, toolName, model].join("\u0000")).digest("hex")
}

export function readCache(dir: string, key: string): unknown | null {
  const file = path.join(dir, `${key}.json`)
  if (!fs.existsSync(file)) {
    if (process.env.REPLAY === "1") throw new CacheMissInReplayError(key)
    return null
  }
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

export function writeCache(dir: string, key: string, value: unknown): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(value, null, 2))
}
```

- [ ] **Step 4: Run to verify passage**

Run: `npx vitest run src/lib/llm/cache.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing adapter tests**

`src/lib/llm/adapter.test.ts` — these use an injected fake provider, so no network and no DB.

```ts
import { describe, it, expect, vi } from "vitest"
import { z } from "zod"
import { callWithSchema, __setProviderForTest, __setRunSinkForTest } from "./adapter"

const S = z.object({ n: z.number() })

describe("callWithSchema", () => {
  it("returns validated data on a first-try success", async () => {
    __setProviderForTest({ name: "fake", call: async () => ({ raw: { n: 1 }, cost: 0.01 }) })
    const runs: any[] = []; __setRunSinkForTest(r => runs.push(r))
    const out = await callWithSchema({ prompt: "p", system: "s", schema: S, toolName: "t", kind: "test" })
    expect(out.data).toEqual({ n: 1 })
    expect(runs).toHaveLength(1)
    expect(runs[0].ok).toBe(true)
  })

  it("retries once with the validation error appended, then succeeds", async () => {
    let seen: string[] = []
    let call = 0
    __setProviderForTest({
      name: "fake",
      call: async ({ prompt }) => {
        seen.push(prompt)
        return { raw: ++call === 1 ? { n: "not a number" } : { n: 2 }, cost: 0.01 }
      },
    })
    const runs: any[] = []; __setRunSinkForTest(r => runs.push(r))
    const out = await callWithSchema({ prompt: "p", system: "s", schema: S, toolName: "t", kind: "test" })
    expect(out.data).toEqual({ n: 2 })
    expect(seen[1]).toContain("p")
    expect(seen[1]).toMatch(/expected number|invalid_type/i)   // error fed back in
    expect(runs).toHaveLength(2)
    expect(runs[0].ok).toBe(false)
    expect(runs[1].ok).toBe(true)
  })

  it("logs a failed run and throws when both attempts fail", async () => {
    __setProviderForTest({ name: "fake", call: async () => ({ raw: { n: "bad" }, cost: 0.01 }) })
    const runs: any[] = []; __setRunSinkForTest(r => runs.push(r))
    await expect(callWithSchema({ prompt: "p", system: "s", schema: S, toolName: "t", kind: "test" }))
      .rejects.toThrow()
    expect(runs).toHaveLength(2)
    expect(runs.every(r => !r.ok)).toBe(true)
    expect(runs[1].output).toBeTruthy()      // raw output retained for the failure log
  })

  it("records latency and cost on every run", async () => {
    __setProviderForTest({ name: "fake", call: async () => ({ raw: { n: 1 }, cost: 0.02 }) })
    const runs: any[] = []; __setRunSinkForTest(r => runs.push(r))
    const out = await callWithSchema({ prompt: "p", system: "s", schema: S, toolName: "t", kind: "test" })
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)
    expect(runs[0].cost).toBe(0.02)
  })
})
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run src/lib/llm/adapter.test.ts`
Expected: FAIL — cannot resolve `./adapter`.

- [ ] **Step 7: Implement providers and adapter**

`src/lib/llm/providers/types.ts`:
```ts
export type ProviderCall = {
  system: string; prompt: string; toolName: string; jsonSchema: object; model: string
}
export type Provider = {
  name: string
  call(args: ProviderCall): Promise<{ raw: unknown; cost: number }>
}
```

`src/lib/llm/providers/openai.ts` — Chat Completions with a forced function tool. Cost from `usage`, priced per the configured model.

`src/lib/llm/providers/anthropic.ts` — Messages API with `tools` plus `tool_choice: { type: "tool", name: toolName }`. Ships as a real implementation to prove the adapter claim.

`src/lib/llm/providers/mock.ts` — deterministic, schema-shaped fixtures keyed by `toolName`. Returns a plausible program/weekly pass/QBR so every screen is buildable and CI runs without a key. Must produce 24 placements when handed 24 learners, each citing a real utterance id passed in the prompt.

`src/lib/llm/adapter.ts`:
- Build JSON Schema from Zod (`z.toJSONSchema` in Zod 4; otherwise a small converter for the object/array/string/number/enum subset these schemas use).
- Check the cache before calling; on hit, return with `cacheHit: true` and `latencyMs: 0`.
- Validate with Zod. On failure, retry once with `\n\nYour previous output failed validation:\n<error>\nReturn output matching the schema exactly.` appended.
- Write an `agentRuns` row per attempt, successes and failures alike, with `attempt`, `ok`, `error`, raw `output`, `latencyMs`, `cost`, `cacheHit`.
- Export `__setProviderForTest` and `__setRunSinkForTest` so tests inject a fake provider and capture rows without a DB.

- [ ] **Step 8: Run to verify passage**

Run: `npx vitest run src/lib/llm/`
Expected: PASS, 10 tests.

- [ ] **Step 9: Write the prompts file**

`src/lib/llm/prompts.ts` — verbatim from build guide Appendix A: program-generation system prompt, user-prompt shape, weekly-pass system prompt, scenario-relevance judge rubric. Add the band reference table from `BAND_TABLE` and the pronunciation-proxy caveat.

- [ ] **Step 10: Commit**

```bash
git add src/lib/llm && git commit -m "feat: provider-agnostic LLM adapter with cache, replay, and retry logging"
```

---

## Task 8: SSE generation route

**Files:**
- Create: `src/app/api/programs/generate/route.ts`
- Create: `src/lib/placement.ts`
- Test: `src/lib/placement.test.ts`, `src/app/api/programs/generate/route.test.ts`

**Interfaces:**
- Consumes: `callWithSchema` (Task 7), schemas (Task 6), DB (Task 4)
- Produces:
  ```ts
  export function buildLearnerBlock(l: LearnerWithScores): string
  // SSE contract: six `event: section` frames keyed
  // cohort | placements | weeks | cadence | successCriteria | kickoff,
  // then `event: done` with { programId }
  ```

- [ ] **Step 1: Write the failing grounding test**

`src/lib/placement.test.ts`:
```ts
import { describe, it, expect } from "vitest"
import { buildLearnerBlock } from "./placement"

const learner = {
  id: "learner_07", name: "Jiwon Park",
  utterances: [
    { id: "u_1043", accuracy: 5, fluency: 4, prosodic: 5 },
    { id: "u_1051", accuracy: 6, fluency: 5, prosodic: 5 },
  ],
  missedPhonemes: [{ phone: "AE1", count: 7 }, { phone: "R", count: 5 }],
}

describe("buildLearnerBlock", () => {
  it("includes the learner id and session count", () => {
    const b = buildLearnerBlock(learner as any)
    expect(b).toContain("learner_07")
    expect(b).toContain("2 sessions")
  })

  it("includes every utterance id so placements can cite real evidence", () => {
    const b = buildLearnerBlock(learner as any)
    expect(b).toContain("u_1043")
    expect(b).toContain("u_1051")
  })

  it("lists most-missed phonemes with counts", () => {
    expect(buildLearnerBlock(learner as any)).toContain("AE1 (7x)")
  })

  it("does NOT leak the learner's name — placement must not infer from names", () => {
    expect(buildLearnerBlock(learner as any)).not.toContain("Jiwon")
  })

  it("stays compact — no raw JSON dumps", () => {
    const b = buildLearnerBlock(learner as any)
    expect(b).not.toContain("{")
    expect(b.length).toBeLessThan(600)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/placement.test.ts`
Expected: FAIL — cannot resolve `./placement`.

- [ ] **Step 3: Implement grounding**

`src/lib/placement.ts` produces exactly the build guide §2d shape:
```
learner_07 | 9 sessions
  sentence scores (accuracy/fluency/prosodic): 5/4/5, 6/5/5, ...
  most-missed phonemes: AE1 (7x), R (5x), TH (4x)
  utterance ids: u_1043, u_1051, u_1062
```
Names and roles are deliberately excluded — the system prompt forbids inferring ability from them, so they must not be in context at all.

- [ ] **Step 4: Run to verify passage**

Run: `npx vitest run src/lib/placement.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing SSE test**

`src/app/api/programs/generate/route.test.ts` — runs against `LLM_PROVIDER=mock`, so it is hermetic.

```ts
import { describe, it, expect, beforeAll } from "vitest"
import { POST } from "./route"

async function collect(res: Response) {
  const text = await res.text()
  return text.split("\n\n").filter(Boolean).map(frame => {
    const ev = /event: (\w+)/.exec(frame)?.[1]
    const data = /data: (.*)/s.exec(frame)?.[1]
    return { event: ev, data: data ? JSON.parse(data) : null }
  })
}

describe("POST /api/programs/generate", () => {
  beforeAll(() => { process.env.LLM_PROVIDER = "mock" })

  it("emits the six sections in order, then done", async () => {
    const req = new Request("http://x/api/programs/generate", {
      method: "POST",
      body: JSON.stringify({ brief: "18 people on our Seoul support team. 10 weeks." }),
    })
    const frames = await collect(await POST(req))
    expect(frames.filter(f => f.event === "section").map(f => f.data.key)).toEqual([
      "cohort", "placements", "weeks", "cadence", "successCriteria", "kickoff",
    ])
    expect(frames.at(-1)!.event).toBe("done")
    expect(frames.at(-1)!.data.programId).toBeTruthy()
  })

  it("sets the SSE content type", async () => {
    const req = new Request("http://x/api/programs/generate", {
      method: "POST", body: JSON.stringify({ brief: "x" }),
    })
    expect((await POST(req)).headers.get("content-type")).toContain("text/event-stream")
  })

  it("emits one placement per seeded learner, each citing evidence", async () => {
    const req = new Request("http://x/api/programs/generate", {
      method: "POST", body: JSON.stringify({ brief: "18 people, Seoul support, 10 weeks" }),
    })
    const frames = await collect(await POST(req))
    const placements = frames.find(f => f.data?.key === "placements")!.data.payload
    expect(placements.length).toBe(24)
    for (const p of placements) expect(p.evidenceUtteranceIds.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run src/app/api/programs/generate/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 7: Implement the route**

`src/app/api/programs/generate/route.ts`:
- `export const runtime = "nodejs"`, `export const maxDuration = 60`.
- `ReadableStream` with `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.
- Three sequential `callWithSchema` calls per the build guide §3: (1) parse brief → `CohortSchema`, emit `cohort`; (2) placement over grounded blocks → `z.array(Placement)`, emit `placements`; (3) `CurriculumSchema`, emit `weeks`, `cadence`, `successCriteria`, `kickoff` as four frames.
- Persist after each call so a mid-stream refresh does not lose work.
- **Pacing:** the build guide wants a section every 1.5–3s, 12–20s total. Real calls supply this naturally; the mock returns instantly. Add a `paceMs` floor between frames (default 1600, `0` when `process.env.NODE_ENV === "test"`) so tests stay fast and the demo does not flash.
- On a failed call, emit `event: error` with a readable message and close. A step-3 failure must not discard the persisted placements.

- [ ] **Step 8: Run to verify passage**

Run: `npx vitest run src/app/api/programs/generate/route.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 9: Commit**

```bash
git add src/lib/placement.ts src/app/api && git commit -m "feat: section-by-section SSE program generation from grounded learner evidence"
```

---

## Task 9: The generation screen

**Files:**
- Create: `src/components/BriefBox.tsx`, `src/components/ProgramStream.tsx`, `src/components/PlacementCard.tsx`
- Modify: `src/app/page.tsx`

**Interfaces:**
- Consumes: the SSE contract (Task 8)
- Produces: `<ProgramStream brief={string} onProgramId={(id: string) => void} />`

- [ ] **Step 1: Build the landing screen**

`src/app/page.tsx`: one centered text box on an otherwise empty page. Placeholder is the real demo brief:
> 18 people on our Seoul support team. They take escalation calls in English. Get them ready in 10 weeks.

Three example chips underneath: the Seoul brief, a baseball-clubhouse brief, a manufacturing-floor brief. Clicking one fills the box.

- [ ] **Step 2: Build the stream consumer**

`ProgramStream.tsx` reads the SSE with `fetch` + `getReader()` (not `EventSource`, which cannot POST), parses frames, and appends cards in arrival order. Six cards per build guide §4:

1. **Cohort** — one sentence restating what it understood
2. **Placements** — 24 compact cards in a grid, band + one-line rationale, clickable
3. **Curriculum** — weeks as a horizontal strip, expandable to scenarios
4. **Cadence** — a single line
5. **Success criteria** — `plainLanguage` large, `measurableProxy` small underneath
6. **Kickoff** — with an EN/KO toggle

Each card fades in with a small stagger; a subtle skeleton hints at the next section. **No spinner text, no "Analyzing…" narration** — the content is the feedback.

- [ ] **Step 3: Add the CEFR caveat to the placements card**

Small, inline, next to the band legend: *Bands are pronunciation-derived proxies from speechocean762 expert scores, not CEFR assessments.* This is a global constraint and this is the screen it belongs on.

- [ ] **Step 4: Verify end to end in the browser**

Run `npm run dev`, open `localhost:3000`, submit the Seoul brief.

Confirm, and record the timing: all six sections arrive in order; total elapsed is **under 25 seconds** (definition-of-done item); no layout shift as cards land; the honesty banner is visible throughout.

- [ ] **Step 5: Commit**

```bash
git add src/app/page.tsx src/components && git commit -m "feat: streaming generation screen with staged section cards"
```

---

## Task 10: Placement evidence and override

**Files:**
- Create: `src/components/EvidencePanel.tsx`
- Create: `src/app/api/placements/[id]/route.ts`
- Test: `src/app/api/placements/[id]/route.test.ts`

**Interfaces:**
- Consumes: `phoneAgreement` (Task 2), `placements`/`wordScores`/`phonemeScores`/`expertScores` (Task 4)
- Produces: `PATCH /api/placements/:id` accepting `{ overriddenBand: Band }`

- [ ] **Step 1: Write the failing override test**

`src/app/api/placements/[id]/route.test.ts`:
```ts
import { describe, it, expect } from "vitest"
import { PATCH } from "./route"
import { db } from "@/db"
import { placements } from "@/db/schema"
import { eq } from "drizzle-orm"

describe("PATCH /api/placements/:id", () => {
  it("writes overriddenBand and NEVER touches the model's original band", async () => {
    const [before] = await db.select().from(placements).limit(1)
    const req = new Request("http://x", { method: "PATCH", body: JSON.stringify({ overriddenBand: "C1" }) })
    const res = await PATCH(req, { params: Promise.resolve({ id: before.id }) })
    expect(res.status).toBe(200)

    const [after] = await db.select().from(placements).where(eq(placements.id, before.id))
    expect(after.overriddenBand).toBe("C1")
    expect(after.band).toBe(before.band)          // the model's word is immutable
    expect(after.rationale).toBe(before.rationale)
  })

  it("rejects a band outside the enum", async () => {
    const [p] = await db.select().from(placements).limit(1)
    const req = new Request("http://x", { method: "PATCH", body: JSON.stringify({ overriddenBand: "Z9" }) })
    const res = await PATCH(req, { params: Promise.resolve({ id: p.id }) })
    expect(res.status).toBe(400)
  })
})
```

This test needs seeded placements. Run a generation against the mock provider first, or skip with a clear message if the table is empty.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/app/api/placements/`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Implement the route**

Validate the body with `z.object({ overriddenBand: z.enum(BANDS) })`. Update **only** `overriddenBand`. Return 400 on a validation failure, 404 on an unknown id.

- [ ] **Step 4: Run to verify passage**

Run: `npx vitest run src/app/api/placements/`
Expected: PASS, 2 tests.

- [ ] **Step 5: Build the evidence panel**

`EvidencePanel.tsx`, opened by clicking a placement card:
- **Audio** — plain `<audio controls src={utterance.audioPath}>`, no waveform library.
- **Word chips** from `wordScores`, coloured by accuracy. Clicking one expands its phoneme strip.
- **Phoneme strip** — per phone, the mean (0–2) as colour, and **all five expert verdicts** beneath. Where `disagreement > 0`, show the split explicitly. Render `insertionsAfter` as a distinct marker: an expert heard a phone that is not in the reference.
- **Expert spread** — a small range bar per word from `expertScores`.
- **The model's rationale**, quoted.
- **Override control** — band selector issuing the `PATCH`. Show the model's original band alongside the override, never replacing it.

- [ ] **Step 6: Verify in the browser**

Click a placement. Confirm: audio plays; word chips are coloured; a clicked word reveals per-phone expert disagreement; overriding to another band persists across a page reload and the original band is still displayed.

- [ ] **Step 7: Commit**

```bash
git add src/components/EvidencePanel.tsx src/app/api/placements && git commit -m "feat: phoneme-level evidence panel with human band override"
```

---

## Task 11: Weekly pass

**Files:**
- Create: `src/lib/weekly.ts`, `src/app/api/programs/[id]/advance/route.ts`
- Test: `src/lib/weekly.test.ts`

**Interfaces:**
- Consumes: DB (Task 4), `callWithSchema` (Task 7), `WeeklyPassSchema` (Task 6)
- Produces:
  ```ts
  /** One seeded session, flattened with that week's mean utterance total. */
  export type SessionRow = {
    learnerId: string
    weekN: number
    completed: boolean
    total: number          // mean sentence `total` across that week's utterances
  }
  export type WeeklyFacts = {
    weekNumber: number
    completed: { learnerId: string; sessions: number }[]
    missed: { learnerId: string; sessions: number }[]
    movement: { learnerId: string; deltaTotal: number; from: number; to: number }[]
    missedPhonemes: { phone: string; count: number }[]
  }
  export function computeWeeklyFacts(rows: SessionRow[], weekNumber: number): WeeklyFacts
  ```

- [ ] **Step 1: Write the failing facts tests**

The load-bearing architectural rule is that **code does the arithmetic and the model does the prose**. These tests are what enforce it.

`src/lib/weekly.test.ts`:
```ts
import { describe, it, expect } from "vitest"
import { computeWeeklyFacts } from "./weekly"

const rows = [
  { learnerId: "a", weekN: 1, completed: true,  total: 5 },
  { learnerId: "a", weekN: 2, completed: true,  total: 7 },
  { learnerId: "b", weekN: 1, completed: true,  total: 6 },
  { learnerId: "b", weekN: 2, completed: false, total: 6 },
  { learnerId: "c", weekN: 1, completed: true,  total: 8 },
  { learnerId: "c", weekN: 2, completed: true,  total: 6 },
]

describe("computeWeeklyFacts", () => {
  it("counts completed sessions for the week", () => {
    const f = computeWeeklyFacts(rows, 2)
    expect(f.completed.map(c => c.learnerId).sort()).toEqual(["a", "c"])
  })

  it("counts missed sessions for the week", () => {
    expect(computeWeeklyFacts(rows, 2).missed.map(m => m.learnerId)).toEqual(["b"])
  })

  it("computes score movement against the previous week", () => {
    const f = computeWeeklyFacts(rows, 2)
    expect(f.movement.find(m => m.learnerId === "a")!.deltaTotal).toBe(2)    // 5 -> 7
    expect(f.movement.find(m => m.learnerId === "c")!.deltaTotal).toBe(-2)   // 8 -> 6
  })

  it("reports no movement for week 1, which has no prior week", () => {
    expect(computeWeeklyFacts(rows, 1).movement.every(m => m.deltaTotal === 0)).toBe(true)
  })

  it("is pure — the same input always yields the same facts", () => {
    expect(computeWeeklyFacts(rows, 2)).toEqual(computeWeeklyFacts(rows, 2))
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/weekly.test.ts`
Expected: FAIL — cannot resolve `./weekly`.

- [ ] **Step 3: Implement the facts computation**

`src/lib/weekly.ts` — pure functions only. No LLM import in this file, which is the structural guarantee that the model never does arithmetic.

- [ ] **Step 4: Run to verify passage**

Run: `npx vitest run src/lib/weekly.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Implement the advance route**

`POST /api/programs/[id]/advance`:
1. Read program state and the seeded sessions up to `currentWeek + 1`.
2. `computeWeeklyFacts(...)` — in code.
3. `callWithSchema` with `WeeklyPassSchema` and the weekly system prompt, passing the computed facts and instructing the model to treat them as true.
4. Persist `managerBrief`, `onTrack`/`slipped`/`atRisk`, `adjustments`, and `drafts` (status `draft`).
5. Increment `currentWeek`.

- [ ] **Step 6: Verify the split holds**

```bash
grep -rn "llm\|callWithSchema" src/lib/weekly.ts
```
Expected: no matches. If this returns anything, the arithmetic/prose boundary has leaked and must be fixed before continuing.

- [ ] **Step 7: Commit**

```bash
git add src/lib/weekly.ts src/app/api/programs && git commit -m "feat: weekly pass with facts computed in code and judgement from the model"
```

---

## Task 12: Monday brief and drafts

**Files:**
- Create: `src/app/program/[id]/page.tsx`, `src/app/program/[id]/week/[n]/page.tsx`
- Create: `src/components/WeekBrief.tsx`, `src/components/DraftCard.tsx`, `src/components/SimulatedTag.tsx`
- Create: `src/app/api/drafts/[id]/route.ts`
- Test: `src/app/api/drafts/[id]/route.test.ts`

**Interfaces:**
- Consumes: `drafts`, `programWeeks` (Task 4)
- Produces: `PATCH /api/drafts/:id` accepting `{ editedBody?: string; status?: "draft" | "approved" }`

- [ ] **Step 1: Write the failing draft tests**

```ts
import { describe, it, expect } from "vitest"
import { PATCH } from "./route"

describe("PATCH /api/drafts/:id", () => {
  it("saves an edited body without destroying the original", async () => { /* asserts body unchanged, editedBody set */ })
  it("flips status to approved", async () => { /* asserts status === "approved" */ })
  it("REFUSES a status of 'sent' — nothing in this system sends mail", async () => {
    const req = new Request("http://x", { method: "PATCH", body: JSON.stringify({ status: "sent" }) })
    const res = await PATCH(req, { params: Promise.resolve({ id: "any" }) })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/app/api/drafts/`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Implement the route**

Validate with `z.object({ editedBody: z.string().optional(), status: z.enum(["draft", "approved"]).optional() })`. `"sent"` is not in the enum, so it 400s — the guarantee is enforced by the schema, not by a comment.

- [ ] **Step 4: Run to verify passage**

Run: `npx vitest run src/app/api/drafts/`
Expected: PASS, 3 tests.

- [ ] **Step 5: Build the week page**

Per build guide §7:
- **Brief at the top**, 3–5 plain sentences, large type, nothing technical.
- **Three counters**: on track, slipped, at risk.
- **Curriculum adjustments**, each with its reason.
- **Draft cards**: recipient, the reason it was written, the body, **Approve** and **Edit**. Edit opens an inline textarea saving via `PATCH`; Approve flips status with a quiet confirmation.
- **Never a sent state.** The UI must not imply a message left the building.

- [ ] **Step 6: Add the `simulated` marker**

`SimulatedTag.tsx` — a small inline tag rendered next to **every** week-over-week figure and score-movement chart, per the global constraint. Apply it on the program page trajectory and the week page's movement figures.

- [ ] **Step 7: Verify in the browser**

Press Advance. Confirm a brief and drafts appear, edit one draft and reload to see it persisted, approve one and see the quiet confirmation, and confirm the `simulated` tag sits beside every movement figure.

- [ ] **Step 8: Commit**

```bash
git add src/app/program src/components src/app/api/drafts && git commit -m "feat: Monday brief with approve/edit drafts and simulated-trajectory markers"
```

---

## Task 13: Evals

**Files:**
- Create: `src/lib/evals.ts`, `scripts/run-evals.ts`, `src/app/evals/page.tsx`, `src/app/api/evals/route.ts`
- Create: `docs/eval-briefs.ts` (the 20 briefs from build guide Appendix B)
- Test: `src/lib/evals.test.ts`

**Interfaces:**
- Consumes: `agentRuns` (Task 4), `bandForAccuracy`/`bandDistance` (Task 3)
- Produces:
  ```ts
  export function placementAccuracy(rows: { predicted: Band; truth: Band }[]):
    { exact: number; withinOne: number; n: number }
  export function schemaConformance(runs: AgentRun[]):
    { firstTry: number; afterRetry: number; attempts: number }
  export function latencyPercentiles(runs: AgentRun[]): { p50: number; p95: number }
  export function judgeAgreement(judge: number[], human: number[]): number
  ```

- [ ] **Step 1: Write the failing eval tests**

```ts
import { describe, it, expect } from "vitest"
import { placementAccuracy, schemaConformance, latencyPercentiles, judgeAgreement } from "./evals"

describe("placementAccuracy — reports BOTH metrics, never just the flattering one", () => {
  it("computes exact and within-one separately", () => {
    const r = placementAccuracy([
      { predicted: "B1", truth: "B1" },   // exact
      { predicted: "B2", truth: "B1" },   // within one
      { predicted: "C1", truth: "A1" },   // neither
      { predicted: "A2", truth: "A2" },   // exact
    ])
    expect(r.n).toBe(4)
    expect(r.exact).toBeCloseTo(0.5)
    expect(r.withinOne).toBeCloseTo(0.75)
  })
  it("returns zeroes rather than NaN for an empty set", () => {
    expect(placementAccuracy([])).toEqual({ exact: 0, withinOne: 0, n: 0 })
  })
})

describe("schemaConformance", () => {
  it("separates first-try success from post-retry success", () => {
    const runs = [
      { ok: true,  attempt: 1 }, { ok: false, attempt: 1 }, { ok: true, attempt: 2 },
      { ok: false, attempt: 1 }, { ok: false, attempt: 2 },
    ] as any
    const c = schemaConformance(runs)
    expect(c.firstTry).toBeCloseTo(1 / 3)     // 1 of 3 logical calls valid first try
    expect(c.afterRetry).toBeCloseTo(2 / 3)   // 2 of 3 valid eventually
  })
})

describe("latencyPercentiles", () => {
  it("computes p50 and p95", () => {
    const runs = Array.from({ length: 100 }, (_, i) => ({ latencyMs: i + 1 })) as any
    const p = latencyPercentiles(runs)
    expect(p.p50).toBeGreaterThanOrEqual(50)
    expect(p.p95).toBeGreaterThanOrEqual(95)
  })
})

describe("judgeAgreement", () => {
  it("is 1 when the judge and the human agree exactly", () => {
    expect(judgeAgreement([3, 2, 1], [3, 2, 1])).toBe(1)
  })
  it("is 0 when they never agree", () => {
    expect(judgeAgreement([3, 3, 3], [0, 0, 0])).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/evals.test.ts`
Expected: FAIL — cannot resolve `./evals`.

- [ ] **Step 3: Implement the scoring functions**

- [ ] **Step 4: Run to verify passage**

Run: `npx vitest run src/lib/evals.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the eval runner**

`scripts/run-evals.ts` runs all 20 briefs from Appendix B through the generator, tagging each `agentRuns` row with `briefLabel`. Ground truth for placement is `learners.trueBand`, which came from `bandForAccuracy` at seed time and is untouched by the model.

The scenario-relevance judge uses the Appendix A rubric, N=20. **Also write your own labels for the same 20** into a committed file and report the judge-versus-human agreement rate — per the build guide, this is the difference between running evals and performing them.

- [ ] **Step 6: Build the evals page**

`src/app/evals/page.tsx`, a query over `agentRuns` plus the scoring functions. Table rows: schema conformance (before and after retry), placement accuracy (**exact and within-one, both shown**), scenario relevance with judge/human agreement, p50/p95 latency, cost per generation, and an expandable failure log with raw output for every schema violation.

Add a plain-language line for the adversarial briefs 16–20 describing what the system actually did with each — the build guide is explicit that how a system handles a bad brief is more revealing than how it handles a good one.

**If the provider is still `mock`, the page must say the numbers are not yet measured** rather than presenting fixture-derived figures as results.

- [ ] **Step 7: Commit**

```bash
git add src/lib/evals.ts scripts/run-evals.ts src/app/evals src/app/api/evals docs/eval-briefs.ts
git commit -m "feat: evals over agent_runs reporting exact and within-one placement accuracy"
```

---

## Task 14: QBR

**Files:**
- Create: `src/app/api/programs/[id]/qbr/route.ts`, `src/app/program/[id]/qbr/page.tsx`

**Interfaces:**
- Consumes: DB (Task 4), `QbrSchema` (Task 6)
- Produces: `POST /api/programs/:id/qbr`

- [ ] **Step 1: Implement the route**

One `callWithSchema` against `QbrSchema`. Cohort-level facts computed in code exactly as in Task 11 — completion rates, band movement, most-improved, at-risk. The model writes business-language narrative only.

- [ ] **Step 2: Build the printable page**

Print stylesheet, `window.print()` as the PDF path. The README states plainly that this is `window.print()` and not a PDF pipeline.

Every longitudinal figure on this page carries the `SimulatedTag` from Task 12.

- [ ] **Step 3: Verify**

Generate a QBR, open print preview, confirm it paginates cleanly and the honesty banner and simulated tags survive into print.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/programs src/app/program && git commit -m "feat: printable QBR with narrative from computed cohort facts"
```

---

## Task 15: README, replay verification, and definition of done

**Files:**
- Create: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: Populate the cache with a real provider**

Requires the user's OpenAI key in `.env` and `LLM_PROVIDER=openai`.

```bash
npm run evals
```
Expected: `.llm-cache/` fills with response files; `agent_runs` gains real rows with real latency and cost.

- [ ] **Step 2: Verify replay works with the key removed**

This is the definition-of-done item that is easiest to skip and most costly to get wrong.

```bash
LLM_API_KEY= REPLAY=1 npm run dev
```
Then submit the Seoul brief through the UI.

Expected: a full program streams from cache with **no** network call. Confirm by checking that `agent_runs` rows for this generation have `cache_hit = true`:
```bash
psql -d speak_pilot -c "select cache_hit, count(*) from agent_runs group by 1;"
```

- [ ] **Step 3: Write the README**

Sections in the build guide's order: what it is; the honesty line; a placeholder for the 90-second video; the live link; how to run locally; the eval numbers; **Architecture: what production would need**; and the speechocean762 CC BY 4.0 attribution.

The Architecture section must state as decisions, not gaps: real auth, a production scheduler in place of the Advance button, Speak Level as the placement signal in place of the public dataset, and channel integration for drafts.

Also state plainly: the cohort was curated to span the score range; the band table was fixed before the first eval run; the trajectory is constructed; QBR export is `window.print()`.

- [ ] **Step 4: Walk the definition of done**

Verify each item and record the result honestly. A failing item gets written down, not quietly dropped.

- [ ] Seoul brief streams a full program in under 25 seconds
- [ ] Click a placement, hear audio, see phoneme evidence, override the band
- [ ] Advance one week, get a brief and drafts, edit one, approve one
- [ ] Evals tab shows a real placement accuracy number
- [ ] `REPLAY=1` works with `LLM_API_KEY` unset
- [ ] Honesty banner on every screen
- [ ] README has the Architecture section
- [ ] speechocean762 CC BY 4.0 attribution present

Out of scope this session, and stated as such: deployed link on a phone in incognito, and the 90-second video.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all suites pass. Record the count.

- [ ] **Step 6: Commit**

```bash
git add README.md .env.example && git commit -m "docs: README with eval numbers, architecture decisions, and dataset attribution"
```
