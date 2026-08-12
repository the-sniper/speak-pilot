# Speak pilot — design decisions

**Date:** 2026-08-12
**Status:** approved, ready for planning

This document records decisions made on top of `docs/speak-pilot-build-guide.md`, which
remains the primary specification. Where the two disagree, this document wins — every
difference below exists because the real dataset or the real environment forced it.

---

## 1. Scope

Build guide Steps 0 through 9, running locally and verified on localhost. Step 10 (deploy)
is out of scope for implementation because it needs Vercel and Neon accounts, but its
artifacts are in scope: README, deploy configuration, and a verified `REPLAY=1` path that
works with `LLM_API_KEY` unset.

---

## 2. Environment

The build guide assumes Docker Postgres and an unspecified LLM provider. This machine
differs.

**Postgres.** A Homebrew `postgresql@15` instance is already running on :5432. Use it via a
`speak_pilot` database rather than starting Docker, whose daemon is off. `docker-compose.yml`
still ships unchanged so a fresh clone gets the documented path; it is not what we run.
`DATABASE_URL` in `.env` points at the local instance.

**LLM provider: OpenAI.** No key is present yet; the user supplies one during the build.

**The adapter stays provider-agnostic.** Build guide §2a claims swapping providers is one
file. Demonstrate rather than assert it: `adapter.ts` exposes `callWithSchema`,
`providers/openai.ts` implements it, and `providers/anthropic.ts` ships as a real second
implementation. Zod → JSON Schema → forced tool call, identical shape on both.

**Third cache mode.** The build guide has `REPLAY=0|1`. Add `LLM_PROVIDER=mock`: a
deterministic fake returning schema-valid fixtures. This is not a shortcut — it is how the
streaming UI, SSE pacing, and every screen get built and verified before a key exists, and
it keeps the test suite runnable in CI permanently. Sequence: build against `mock`, switch to
`openai` when the key lands, run the 20 eval briefs once to populate `.llm-cache/`, then
`REPLAY=1` serves that cache forever.

Until a real provider run has happened, the Evals tab must say its numbers are unpopulated
rather than display mock-derived figures as though they were measurements.

**Dataset location.** `../.speak-pilot-data/speechocean762/`, outside the repo. Downloaded
and verified: 497MB, 5,518 files. Only the ~240 converted `.opus` files enter the repo, under
`public/audio/`.

---

## 3. Dataset corrections

Build guide §1b describes fields that do not match the shipped data. Verified against all
5,000 utterances.

| Build guide | Reality |
|---|---|
| `mispronunciations: [{canonical-phone, pronounced-phone, index}]` | **Field does not exist.** Zero occurrences in 5,000 utterances |
| `phones-accuracy` are integers 0/1/2 | Floats 0.0–2.0; they are the **mean across five experts** |
| `completeness: 1.0` | `scores.json` uses 0–10; `scores-detail.json` uses 0–1. Different scales in the two files |
| 8–12 utterances per speaker | Exactly **20 per speaker**, uniform across all 250 |
| `scores.json` is a list of utterance objects | Keyed object, utterance id → utterance |

Confirmed accurate: sentence scores 0–10, word accuracy 0–10, `stress` ∈ {5, 10}.

### 3.1 Phoneme evidence

The per-phone verdicts the build guide wanted are recoverable from `scores-detail.json`,
which encodes each expert's judgement as markup against `ref-phones`:

```
ref-phones: "B EH0 R"
expert 1:   "B (EH0) (R)"     EH0 → 0, R → 0
expert 2:   "B {EH0} {R}"     EH0 → 1, R → 1
expert 3:   "B EH0 R"         all correct
expert 5:   "B EH0 [L] R"     intrusive L inserted
```

Legend, per the dataset README: bare = 2 (correct), `{X}` = 1 (accented), `(X)` = 0
(wrong or missed), `[X]` = inserted phone.

**Decision:** write a parser for this markup and render **per-expert phone disagreement** in
`EvidencePanel`. Each phone shows all five verdicts plus any insertions. This delivers both
the build guide's phoneme strip and its "expert spread" feature from one data source, and it
is strictly more informative than the mispronunciation pairs the guide expected.

The parser is a discrete unit with one job — `parsePhoneMarkup(expertPhones, refPhones) →
PhoneVerdict[]` — and is unit-tested directly against the README's own worked examples.

---

## 4. The constructed trajectory

Build guide §1c orders each speaker's utterances by score ascending, assigns them to weeks
1..N, and calls the result "a trajectory from real recordings and real scores."

**This dataset has no time dimension.** Each speaker recorded all 20 utterances in one
sitting. Sorting by score produces an improvement curve that is not in the data. The
recordings and scores are real; the arc is synthetic — and the arc is what Step 6's score
movement, Step 7's manager brief, and Step 9's QBR all narrate.

**What is unaffected:** placement reads real scores at a point in time and is graded against
real five-expert consensus. The headline eval number stays fully honest. Only the
longitudinal story is constructed.

**Decision:** keep the sort-into-weeks device, and mark it in two places.

1. **Expanded persistent banner**, on every screen:

   > Northwind Support and its people are fictional. Every recording, score, and expert
   > annotation is real human-annotated learner speech from speechocean762 (CC BY 4.0). The
   > week-over-week trajectory is constructed — the dataset captures one session per speaker,
   > so progress over time is simulated by ordering real utterances. Placement accuracy is
   > measured against real expert consensus and is not simulated.

2. **Inline `simulated` marker** on every week-over-week chart and score-movement figure, so
   the distinction appears at the point of the claim rather than only in the footer.

---

## 5. Band mapping

Placement accuracy requires a fixed function from expert scores to band. Two constraints
shape it.

**Absolute cutoffs, not percentiles.** Defining bands as cohort quintiles and then grading
the model against those same quintiles makes "within one band" nearly free and the headline
number meaningless. Cutoffs are absolute, fixed, and committed before the first eval run.

Derived from the speaker-level five-expert mean accuracy across all 250 speakers
(min 3.93, median 8.05, max 9.31):

| Band | 5-expert mean accuracy | Share of 250 speakers |
|---|---|---|
| A1 | < 5.5 | 33 (13.2%) |
| A2 | 5.5 – 6.9 | 21 (8.4%) |
| B1 | 7.0 – 7.9 | 63 (25.2%) |
| B2 | 8.0 – 8.6 | 83 (33.2%) |
| C1 | > 8.6 | 50 (20.0%) |

Shares are measured, not estimated. A1 is larger than A2 because the distribution has a
long low tail rather than a clean gradient. All five bands are populated and none exceeds
35%, so the table does not collapse into a single band.

**Cohort selection may be curated; the band function may not.** The 24 speakers are selected
to span the score range so the demo is not 20 identical B2 cards. That selection is stated in
the README. The grading function is untouched.

**Report both metrics.** Exact-band match alongside within-one-band. With five bands, ±1 is
generous, and quoting only the flattering figure is what the build guide's own eval section
warns against.

**Labels stay CEFR, with a prominent caveat.** speechocean762 scores pronunciation accuracy;
CEFR measures general proficiency including grammar, vocabulary, and discourse. Calling a
pronunciation score "B2" is a category error. The schema keeps `z.enum(["A1","A2","B1","B2","C1"])`
per the build guide, and both the README and the placement UI state that these are
pronunciation-derived proxies, not CEFR assessments.

---

## 6. Cohort construction

24 speakers, selected deterministically with a fixed seed so the seed script is reproducible.
Selection satisfies two constraints simultaneously:

- **Band spread** — cohort spans A1 through C1 per §5.
- **Narrative shape** — per build guide §1c: 4 strong improvers, 12 modest, 5 plateau, 2
  declining, 1 who stops. Verified available in the data: per-speaker score spread ranges
  from 1 point (tightest, suits plateau) to 8 points (widest, suits strong improvement).

Each speaker has 20 utterances against horizons of 4–16 weeks across the eval briefs.
Distribute them as `[base, rem] = divmod(20, horizonWeeks)`, with `base` capped at 3 sessions
per week and `rem` weeks receiving one extra. This uses all 20 utterances for horizons of 8
weeks and above, and 12 of 20 for a 4-week horizon where the cap binds. The learner who
"stops" is truncated early by design.

Fictional names and roles are assigned over real speakers. The org is Northwind Support,
obviously fictional. The dataset's real `spk2age` and `spk2gender` metadata is **not** used
to shape personas — the personas are independent fiction, which avoids implying the demo
knows demographic facts about real recorded people.

---

## 7. Division of labour, code versus model

Restated from build guide Step 6 because it is the load-bearing architectural decision:

**Code computes what happened.** Session completion, score movement, most-missed phonemes,
counts, all arithmetic.

**The model decides what to say and what to change.** Wording, judgement, curriculum
adjustments, draft messages.

The model receives computed facts and is instructed to treat them as true. It never
recomputes them. This is what keeps the weekly pass defensible.

---

## 8. Testing

- **Unit**, on pure functions with real fixtures: `parsePhoneMarkup` against the dataset
  README's worked examples; band mapping against known score inputs; the weekly fact
  computations against a hand-checked learner.
- **Schema**, on every Zod schema: valid payloads pass, malformed ones fail with useful errors.
- **Integration**, with `LLM_PROVIDER=mock`: generate a program end to end, assert the SSE
  emits all six sections in order and terminates with `done`.
- **Replay verification**, as an explicit check: `REPLAY=1` with `LLM_API_KEY` unset serves a
  full generation from cache. This is a definition-of-done item and is easy to leave until
  it is too late to fix.

---

## 9. Deferred

Not built, stated in the README's Architecture section as decisions rather than gaps: real
auth, a production scheduler in place of the Advance button, Speak Level as the placement
signal in place of the public dataset, and channel integration for drafts. Drafts are never
auto-sent and the UI never shows a state implying a message left the building.
