# Pilot: build guide

Implementation document for the Speak outreach demo. This is the doc you build from, or hand to a coding agent.

Companion to `speak-pilot-complete-plan.md`, which covers why. This covers how.

**Target:** working, deployed, 8 hours.

**Note on method:** Speak made coding agents their default engineering mode in December 2025 and now interviews by having candidates build a feature live with Claude Code or Codex. Building this with an agent and saying so is on-brand, not a shortcut. Keep the commit history clean either way.

> **Deltas:** `docs/superpowers/specs/2026-08-12-speak-pilot-design.md` records decisions made on top of this guide, including corrections where the real dataset does not match §1b. Where the two disagree, the design doc wins.

---

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Repo structure](#2-repo-structure)
3. [Step 0: scaffold](#step-0-scaffold-20-min)
4. [Step 1: dataset and seed](#step-1-dataset-and-seed-60-min)
5. [Step 2: LLM layer](#step-2-llm-layer-45-min)
6. [Step 3: program generation with SSE](#step-3-program-generation-with-sse-45-min)
7. [Step 4: the generation screen](#step-4-the-generation-screen-90-min)
8. [Step 5: placement evidence and override](#step-5-placement-evidence-and-override-45-min)
9. [Step 6: weekly pass](#step-6-weekly-pass-60-min)
10. [Step 7: Monday brief and drafts](#step-7-monday-brief-and-drafts-30-min)
11. [Step 8: evals](#step-8-evals-45-min)
12. [Step 9: QBR](#step-9-qbr-30-min)
13. [Step 10: ship](#step-10-ship-30-min)
14. [Appendix A: prompts](#appendix-a-prompts)
15. [Appendix B: eval briefs](#appendix-b-eval-briefs)
16. [Appendix C: env and commands](#appendix-c-env-and-commands)

---

## 1. Prerequisites

- Node 20+
- Docker (local Postgres) or a [Neon](https://neon.tech) free tier database
- ffmpeg (audio conversion)
- One LLM API key, Anthropic or OpenAI
- ~1GB free disk temporarily for the dataset

**Stack decisions, locked:**

| Choice | What | Why |
|---|---|---|
| Framework | Next.js App Router | One repo, route handlers do SSE via `ReadableStream`, deploys to Vercel unchanged |
| DB | Postgres + Drizzle ORM | TypeScript-native schema, readable migrations, Neon free tier for deploy |
| Styling | Tailwind | You already use it |
| Validation | Zod | Same schema drives the LLM tool definition and the runtime guard |
| LLM | Thin provider adapter | Speak's own voice platform is deliberately provider-agnostic. Mirroring that is a small, noticed detail |

---

## 2. Repo structure

```
pilot/
  README.md
  docker-compose.yml
  drizzle.config.ts
  .env.example
  scripts/
    fetch-dataset.sh          one-time, not committed output
    seed.ts                   builds the org from speechocean762
  src/
    db/
      schema.ts               drizzle tables
      index.ts                client
    lib/
      llm/
        adapter.ts            provider-agnostic call + tool use
        cache.ts              hash -> response, file-backed
        prompts.ts            all prompt text, one place
      schemas.ts              Zod: Program, WeeklyPass, QBR
      placement.ts            grounding: learner scores -> model input
      evals.ts                scoring functions
    app/
      page.tsx                the one text box
      program/[id]/page.tsx   program view
      program/[id]/week/[n]/page.tsx
      evals/page.tsx
      api/
        programs/generate/route.ts     SSE
        programs/[id]/route.ts
        programs/[id]/advance/route.ts
        programs/[id]/qbr/route.ts
        placements/[id]/route.ts
        drafts/[id]/route.ts
        evals/route.ts
    components/
      BriefBox.tsx
      ProgramStream.tsx       renders sections as they arrive
      PlacementCard.tsx
      EvidencePanel.tsx       audio + word chips + phoneme strip
      WeekBrief.tsx
      DraftCard.tsx
      HonestyBanner.tsx
  public/
    audio/                    converted subset, ~240 files
    data/                     nothing at runtime, seed writes to DB
```

---

## Step 0: scaffold (20 min)

```bash
npx create-next-app@latest pilot --typescript --tailwind --app --src-dir --eslint
cd pilot
npm i drizzle-orm postgres zod
npm i -D drizzle-kit tsx @types/pg
```

`docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: pilot
      POSTGRES_DB: pilot
    ports: ["5432:5432"]
    volumes: ["./.pgdata:/var/lib/postgresql/data"]
```

Add `HonestyBanner` to the root layout now, before you forget:

> The company and the people are fictional. Every recording and every score is real human-annotated learner speech from speechocean762 (CC BY 4.0).

Small, persistent, on every screen. Not a modal.

---

## Step 1: dataset and seed (60 min)

### 1a. Fetch

Download from [OpenSLR SLR101](https://www.openslr.org/101/), around 520MB compressed. Extract to a scratch dir outside the repo.

You need three things from it:

- `scores.json` (aggregated scores per utterance)
- `scores-detail.json` (all five annotators separately)
- the `WAVE/` audio tree

### 1b. Understand the shape

Per utterance in `scores.json`:

```jsonc
{
  "text": "THE BOY RAN AWAY",
  "accuracy": 8, "completeness": 1.0, "fluency": 7, "prosodic": 7, "total": 8,
  "words": [
    {
      "text": "THE", "accuracy": 10, "stress": 10, "total": 10,
      "phones": ["DH", "AH0"],
      "phones-accuracy": [2, 2],
      "mispronunciations": []
    },
    {
      "text": "RAN", "accuracy": 4, "stress": 10, "total": 5,
      "phones": ["R", "AE1", "N"],
      "phones-accuracy": [1, 0, 2],
      "mispronunciations": [{ "canonical-phone": "AE1", "pronounced-phone": "EH1", "index": 1 }]
    }
  ]
}
```

Sentence scores 0-10. Word accuracy 0-10, stress 5 or 10. Phoneme scores 0 (wrong or missed), 1 (accented), 2 (correct). `scores-detail.json` has the same shape but with each of the five experts' values.

**This is the whole reason the demo needs no ML.** Ground truth is in the file.

### 1c. Select the cohort

`scripts/seed.ts` picks **24 speakers**, 8 to 12 utterances each. Bias the selection so the cohort has narrative shape, otherwise every chart is flat and boring:

- 4 who improve strongly (wide gap between their low and high scored utterances)
- 12 who improve modestly
- 5 who plateau (tight score cluster)
- 2 who go backwards
- 1 who stops (fewer sessions, gap at the end)

For each speaker, order their utterances by sentence `total` ascending and assign them to weeks 1..N. That produces a trajectory from real recordings and real scores.

Give learners plausible names and roles. Keep the org fictional and obviously so (call it "Northwind Support" or similar, never a real company name).

### 1d. Convert audio

240 wavs is 20MB+ in the repo. Shrink it:

```bash
for f in selected/*.wav; do
  ffmpeg -i "$f" -c:a libopus -b:a 24k "public/audio/$(basename "${f%.wav}").opus"
done
```

Speech at 24kbps opus is fine and gets you under 10MB total. Fall back to mp3 if you hit browser support issues.

### 1e. Schema

`src/db/schema.ts`, Drizzle. Tables as specified in the plan:

`orgs`, `cohorts`, `learners`, `programs`, `program_weeks`, `scenarios`, `placements`, `sessions`, `utterances`, `word_scores`, `phoneme_scores`, `expert_scores`, `agent_runs`, `drafts`.

Two columns worth calling out:

- `placements.overridden_band` separate from `placements.band`. Never overwrite what the model said. The diff between the two is a feature and, if you extend this, training signal.
- `agent_runs` stores `input`, `output`, `latency_ms`, `cost`, `ok`. Every LLM call writes a row. The Evals tab is a query over this table, not a separate system.

**Done when:** `select` on a learner returns their utterances, word scores, phoneme scores, and all five expert scores.

---

## Step 2: LLM layer (45 min)

### 2a. Adapter

`src/lib/llm/adapter.ts`. One function:

```ts
callWithSchema<T>({
  prompt: string,
  system: string,
  schema: z.ZodType<T>,
  toolName: string,
  maxRetries?: number      // default 1
}): Promise<{ data: T; runId: string; latencyMs: number; cost: number }>
```

Behaviour:

1. Convert the Zod schema to JSON Schema, pass as a tool definition, force the tool call
2. Parse and validate the response with Zod
3. On validation failure: retry once, appending the validation error to the prompt
4. Write an `agent_runs` row either way, including failures
5. Check the cache first, write to it on success

Keep the provider behind this function. Swapping Anthropic for OpenAI should be one file.

### 2b. Cache

`src/lib/llm/cache.ts`. Key on `sha256(system + prompt + toolName + model)`. Store responses as JSON files under `.llm-cache/`, committed.

Then:

```
REPLAY=1  -> serve only from cache, never call the API, throw on a miss
```

Twenty minutes of work. It means your deployed link works when the key expires or the network is bad, which will happen at the worst moment. Say you did it in the README.

### 2c. Zod schemas

`src/lib/schemas.ts`:

```ts
export const Placement = z.object({
  learnerId: z.string(),
  band: z.enum(["A1","A2","B1","B2","C1"]),
  rationale: z.string().max(280),
  evidenceUtteranceIds: z.array(z.string()).min(1),   // required, this is the point
})

export const Scenario = z.object({
  title: z.string(),
  situation: z.string(),
  targetPhrases: z.array(z.string()).min(3).max(8),
  successLooksLike: z.string(),
})

export const ProgramSchema = z.object({
  cohort: z.object({
    size: z.number(), l1: z.string(), role: z.string(), horizonWeeks: z.number(),
  }),
  placements: z.array(Placement),
  weeks: z.array(z.object({
    n: z.number(), theme: z.string(), scenarios: z.array(Scenario).min(2).max(4),
  })),
  cadence: z.object({ sessionsPerWeek: z.number(), minutesPerSession: z.number() }),
  successCriteria: z.array(z.object({
    plainLanguage: z.string(),      // no CEFR jargon allowed
    measurableProxy: z.string(),
  })).min(2),
  kickoffMessage: z.object({ en: z.string(), ko: z.string() }),
})

export const WeeklyPassSchema = z.object({
  weekNumber: z.number(),
  onTrack: z.array(z.string()),
  slipped: z.array(z.string()),
  atRisk: z.array(z.string()),
  managerBrief: z.string(),         // 3 to 5 sentences, plain language
  curriculumAdjustments: z.array(z.object({
    weekN: z.number(), change: z.string(), reason: z.string(),
  })),
  drafts: z.array(z.object({
    learnerId: z.string(), channel: z.enum(["email","slack"]),
    subject: z.string(), body: z.string(), reason: z.string(),
  })),
})
```

`evidenceUtteranceIds.min(1)` is the single most important line in this file. It forces every placement to be traceable to a real recording, which is what makes the eval number honest.

### 2d. Grounding

`src/lib/placement.ts`. Before calling the model, build a compact per-learner block:

```
learner_07 | 9 sessions
  sentence scores (accuracy/fluency/prosodic): 5/4/5, 6/5/5, 6/6/6, 7/6/6 ...
  most-missed phonemes: AE1 (7x), R (5x), TH (4x)
  utterance ids: u_1043, u_1051, u_1062 ...
```

Do not send raw JSON dumps. Do not let the model invent scores. It sees only real numbers and picks a band.

---

## Step 3: program generation with SSE (45 min)

`src/app/api/programs/generate/route.ts`.

```ts
export const runtime = "nodejs"
export const maxDuration = 60
```

Return a `Response` wrapping a `ReadableStream` with `Content-Type: text/event-stream`.

**Stream section by section, not token by token.** Token streaming looks like a chatbot. Section streaming looks like a system doing work, which is the effect you want:

```
event: section  data: {"key":"cohort","payload":{...}}
event: section  data: {"key":"placements","payload":[...]}
event: section  data: {"key":"weeks","payload":[...]}
event: section  data: {"key":"cadence","payload":{...}}
event: section  data: {"key":"successCriteria","payload":[...]}
event: section  data: {"key":"kickoff","payload":{...}}
event: done     data: {"programId":"..."}
```

Simplest approach that gets this shape: **three sequential calls** rather than one giant one.

1. Parse the brief into `{ size, l1, role, horizonWeeks }` and match learners. Emit `cohort`.
2. Placement, with the grounded learner blocks. Emit `placements`.
3. Curriculum, cadence, success criteria, kickoff. Emit the rest.

This is better than one call for three reasons: each has a smaller schema so conformance goes up, the sections arrive with natural pacing instead of all at once at the end, and a failure in step 3 does not lose the placements.

Persist as you go so a refresh mid-stream does not lose work.

---

## Step 4: the generation screen (90 min)

The screen that sells the whole thing. Budget the most time here.

`src/app/page.tsx`: one text box, centered, on an otherwise empty page. Placeholder is the actual demo brief:

> 18 people on our Seoul support team. They take escalation calls in English. Get them ready in 10 weeks.

Three example chips underneath for people who will not type: the Seoul one, a Nationals-style clubhouse one, a manufacturing floor one.

`ProgramStream.tsx` consumes the SSE and renders sections as cards that appear in order.

**Get the pacing right.** If everything lands in 400ms it reads as a canned animation and the effect dies. If it takes 40 seconds people leave. Aim for a section every 1.5 to 3 seconds, roughly 12 to 20 seconds total. Each card fades in with a small stagger. A subtle skeleton for the next section makes it feel like work in progress rather than a slideshow.

Cards, in order:

1. **Cohort.** One sentence restating what it understood
2. **Placements.** 24 compact cards in a grid, band and one-line rationale, clickable
3. **Curriculum.** Weeks as a horizontal strip, expandable to scenarios
4. **Cadence.** A single line
5. **Success criteria.** The plain-language version large, the measurable proxy small underneath
6. **Kickoff message.** With an EN/KO toggle

Do not narrate in the UI. No "Analyzing..." spinner text. Let the content be the feedback.

---

## Step 5: placement evidence and override (45 min)

Click a placement card, a panel opens.

`EvidencePanel.tsx`:

- **Audio player** for the cited utterance. Use `<audio>`, no waveform library needed at this scope.
- **Word chips** from `word_scores`, colored by accuracy. Click one to expand its phoneme strip showing the 0/1/2 values and, where present, the mispronunciation (`AE1` produced as `EH1`).
- **Expert spread**, a small range bar per word from `expert_scores`. Where the five annotators disagreed, show it. This is the detail an engineer will stop on.
- **The model's rationale**, quoted.
- **Override control**: a band selector that writes `overridden_band` via `PATCH /api/placements/:id`. Never overwrite `band`.

The override button matters more than it looks. Automated placement is a real product risk, and showing you built the escape hatch signals product maturity better than any amount of polish.

---

## Step 6: weekly pass (60 min)

`src/app/api/programs/[id]/advance/route.ts`.

The plan calls for a scheduler in production. **Build a button.** It demos better and the README says what it would be.

Each call:

1. Read program state and the sessions "completed" up to this week (from seeded data)
2. Compute the mechanical facts in code, not in the model: who completed sessions, who did not, score movement per learner, most-missed phonemes this week
3. Pass those facts to the model with `WeeklyPassSchema`
4. Persist the brief, the adjustments and the drafts

**Split the work correctly.** Code decides *what happened*. The model decides *what to say and what to change*. If you let the model compute who slipped, it will get arithmetic wrong and the demo becomes indefensible. This split is also the thing a senior reviewer will look for.

---

## Step 7: Monday brief and drafts (30 min)

`src/app/program/[id]/week/[n]/page.tsx`.

- **Brief at the top**, three to five plain sentences, large type. This is what the manager reads. Nothing technical.
- **Three counters**: on track, slipped, at risk.
- **Curriculum adjustments**, each with its reason.
- **Draft cards**, each with the recipient, the reason it was written, the body, and **Approve** / **Edit**.

Edit opens an inline textarea, saves via `PATCH /api/drafts/:id`. Approve flips status and shows a quiet confirmation.

**Never auto-send. Never show a sent state that implies a message left the building.** The approve step is the product design, not a disclaimer, and it is what stops an enterprise buyer getting nervous.

---

## Step 8: evals (45 min)

`src/app/evals/page.tsx`, backed by a query over `agent_runs` plus scoring functions in `src/lib/evals.ts`.

Run the generator across the 20 briefs in Appendix B and report:

| Metric | Computation |
|---|---|
| **Schema conformance** | valid / attempts, shown before and after retry |
| **Placement accuracy** | percent of learners placed within one band of the five-expert consensus. Map mean expert sentence accuracy to bands with a fixed table, document the table |
| **Scenario relevance** | LLM judge, rubric in Appendix A, N=20, plus your own labels on the same 20 and the agreement rate between you and the judge |
| **p50 / p95 latency** | from `agent_runs.latency_ms` |
| **Cost per generation** | from `agent_runs.cost` |
| **Failure log** | every schema violation with the raw output, expandable |

**"Placed 22 of 24 within one band of expert consensus"** is the headline. Legible to a non-technical stakeholder, unarguable to an engineer.

Report the judge-versus-you agreement rate rather than the judge score alone. Anyone who has run LLM evals will notice that you did, and it is the difference between showing evals and performing them.

**If the number is bad, ship it and say what you would change.** A measured bad number beats an unmeasured good impression, and it gives them something to talk to you about.

---

## Step 9: QBR (30 min)

`POST /api/programs/[id]/qbr`. One call, cohort-level facts computed in code, model writes the narrative in business language. Render as a printable page. `window.print()` is an acceptable PDF path at this scope, and saying so in the README is better than pretending you built a PDF pipeline.

**Cut this first** if you are running long and the audience skews engineering.

---

## Step 10: ship (30 min)

- Deploy to Vercel. Neon free tier for Postgres. `REPLAY=1` in production so the live link never depends on an API key.
- Seed the production database once from the same script.
- **Verify the deployed link in an incognito window on a phone.**
- **Verify replay mode with the API key removed from the environment.** This is the check people skip and then regret.
- Record the 90 second walkthrough (script is in the plan doc, section 10). Put it at the top of the README, above the live link.
- README sections, in order: what it is, the honesty line, the 90 second video, the live link, how to run locally, the eval numbers, **Architecture: what production would need** (real auth, a scheduler, Speak Level as the placement signal instead of the public dataset, channel integration for drafts), and the speechocean762 CC BY 4.0 attribution.

That Architecture section is what turns every "out of scope" item from a gap into a stated decision. Do not skip it.

---

## Appendix A: prompts

Keep all prompt text in `src/lib/llm/prompts.ts`. One file, easy to diff, easy to point at in an interview.

### Program generation, system prompt

```
You design corporate language training programs for teams learning English
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
  interpretation and proceed. Do not ask questions.
```

### Program generation, user prompt shape

```
BRIEF: {verbatim admin input}

LEARNERS AND EVIDENCE:
{grounded blocks from src/lib/placement.ts}

BAND REFERENCE:
A1 novice ... C1 advanced professional
{the mapping table you documented}

Produce a complete program.
```

### Weekly pass, system prompt

```
You write the weekly update an L&D manager sends to their team, and you
adjust the training program based on what actually happened.

You will be given computed facts. Treat them as true and do not recompute
them. Your job is judgment and wording, not arithmetic.

Rules:
- managerBrief is 3 to 5 sentences, plain language, no jargon, no CEFR codes.
- Only propose a curriculum adjustment when the data supports it. Name the
  data in the reason field.
- Drafted messages are warm and short. Never guilt-trip. Never mention
  rankings or comparisons to colleagues.
- Every draft states, in the reason field, exactly which fact triggered it.
```

### Scenario relevance judge

```
Score this training scenario for relevance to the stated job role, 0 to 3.

0 generic, could apply to any role
1 loosely related to the role's domain
2 clearly relevant to the role
3 specific to a real situation this role faces, with the right register

Output the score and one sentence of justification. Judge relevance only.
Ignore writing quality.
```

---

## Appendix B: eval briefs

Twenty briefs for the Evals tab. Deliberately varied in clarity, because real admins write badly.

**Clear:**

1. 18 people on our Seoul support team. They take escalation calls in English. Get them ready in 10 weeks.
2. 12 warehouse supervisors in Osaka, need safety briefings and shift handovers in English, 8 weeks.
3. 20 hotel front desk staff in Taipei, check-in and complaint handling, 12 weeks.
4. 15 nurses, patient intake and family updates, 16 weeks.
5. 9 sales engineers, technical demos and objection handling, 10 weeks.

**Vague:**

6. Help my team get better at English before the Q3 offsite.
7. We need our engineers to run standups in English.
8. Customer service, 20 people, as fast as possible.
9. Make our Tokyo office more comfortable on client calls.
10. Onboarding for new hires who need business English.

**Constrained or awkward:**

11. 6 people, 4 weeks, they present to the US board and are terrified.
12. 30 people, mixed levels, only 10 minutes a day available.
13. Baseball clubhouse, Spanish and English both directions, spring training timeline.
14. Night shift only, cannot attend live sessions, 12 weeks.
15. Two teams merging, one Korean one Japanese, need a shared working language.

**Adversarial:**

16. Everyone needs to be C1 by next month.
17. Just do whatever you did last time.
18. 500 people.
19. They already speak English fine, this is a compliance checkbox.
20. Make them sound American.

Numbers 16 through 20 are the interesting ones. A good system pushes back inside the output (a success criterion that says the timeline is unrealistic, or a program that reframes "sound American" as intelligibility). Whatever it does, **report it honestly in the eval table.** How a system handles a bad brief is more revealing than how it handles a good one, and it is a great thing to be asked about in an interview.

---

## Appendix C: env and commands

`.env.example`:

```
DATABASE_URL=postgres://postgres:pilot@localhost:5432/pilot
LLM_PROVIDER=anthropic          # or openai
LLM_API_KEY=
LLM_MODEL=
REPLAY=0                        # 1 = cache only, never call the API
```

`package.json` scripts:

```json
{
  "db:up":     "docker compose up -d",
  "db:push":   "drizzle-kit push",
  "seed":      "tsx scripts/seed.ts",
  "dev":       "next dev",
  "evals":     "tsx scripts/run-evals.ts",
  "build":     "next build"
}
```

First run:

```bash
npm run db:up && npm run db:push && npm run seed && npm run dev
```

---

## Definition of done

- [ ] Type the Seoul brief, watch a full program stream in under 25 seconds
- [ ] Click a placement, hear the audio, see the phoneme evidence, override the band
- [ ] Press Advance one week, get a brief and drafts, edit one, approve one
- [ ] Evals tab shows a real placement accuracy number
- [ ] `REPLAY=1` works with `LLM_API_KEY` unset
- [ ] Honesty banner on every screen
- [ ] Deployed link opens on a phone in incognito
- [ ] 90 second video at the top of the README
- [ ] README has the Architecture section
- [ ] speechocean762 CC BY 4.0 attribution present
