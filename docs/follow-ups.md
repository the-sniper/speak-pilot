# Known limitations and follow-ups

Recorded at the end of the build so they are not lost. Each was found by review, judged
deliberately, and left in place with a reason — none is an unexamined gap.

## 1. Failure classification is inferred, not recorded

`failureClass()` in `src/app/evals/page.tsx` splits transport errors from schema violations
by testing `output === null`. That inference is correct for the only failure that has actually
occurred (a `fetch failed` on eval brief 9), but `adapter.ts`'s catch wraps the whole
`provider.call()`, so three other throw sites land in the same bucket:

- a non-2xx HTTP status (a response *did* arrive),
- a 200 response with no tool call / no `tool_use` block,
- malformed JSON in `function.arguments`.

Any of those would be labelled "transport error" — absolving the model for something
model-attributable. None has fired in observed data.

**Fix:** an explicit `errorKind` column on `agent_runs`, set at the throw site, instead of
inferring from the shape of the row.

## 2. The scenario-relevance judge did not discriminate

On the recorded sweep the judge scored all 19 scenarios 3/3 — zero variance. The
judge-vs-labeler agreement rate (68%) is therefore measured against an instrument with no
demonstrated discriminating power, and both sides of that comparison are language models.
This is stated on `/evals` and in the README.

**Fix:** labels written by this repo's author, reading the real generated scenario text, and
a judge prompt that is shown to separate adequate from excellent before its scores are used.

## 3. One eval brief failed and was not retried

Brief 9 failed with a network error during the recorded sweep. The sweep correctly continued.
The failure now writes an `ok: false` row (it did not at the time), and `incompleteBriefs` on
`/evals` flags any brief missing a required generation step.

**Fix:** a bounded retry on transport failure in `run-evals.ts`, distinct from the existing
schema-validation retry.

## 4. Smaller items, deliberately shipped

- `SectionSkeleton`'s switch has no exhaustiveness guard, unlike `renderSectionCard`.
- `ProgramStream`'s completion-watchdog state machine is browser-verified but has no unit test.
- `scripts/seed.ts` is a single long `main()`; the stats build and the DB write could be split.
- `expert_scores.completeness` is stored 0–10 (converted from the corpus's 0–1) and this is
  documented only at the insert site, not in `src/db/schema.ts`.
- The eval "human labels" file name predates the inter-model framing; the contents are
  explicit but the filename still says `human`.
- eslint reports 16 `no-explicit-any` errors in test fixtures (baseline was 13). Consistent
  with the existing convention in those files; the branch does not land eslint-clean.
