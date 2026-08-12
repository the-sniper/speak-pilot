import { BANDS } from "@/lib/bands"
import type { Provider, ProviderCall } from "./types"

// The mock provider is how every screen gets built before a real API key
// exists, and how CI runs forever with LLM_PROVIDER=mock / REPLAY=1. It must be:
//   - deterministic: same input -> same output, every time (no Math.random/Date.now)
//   - schema-valid for whatever JSON Schema it's handed, not just the four
//     schemas known today — it walks the schema structurally instead of
//     switching on toolName, so a schema this file has never seen still comes
//     back valid.
//   - grounded for placements: every evidenceUtteranceIds entry is copied out
//     of the prompt text, never invented, and there's exactly one placement
//     per distinct learner id found in the prompt.

// learnerId format is `learner-<speakerId>`, set in scripts/seed.ts.
const LEARNER_ID_RE = /learner-[A-Za-z0-9]+/g
// Real speechocean762 utterance ids are 9-digit strings (see the comment on
// `utterances.id` in src/db/schema.ts, e.g. "000010011").
const UTTERANCE_ID_RE = /\b\d{9}\b/g

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h >>> 0
}

function extractLearnerIds(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(LEARNER_ID_RE)) {
    if (!seen.has(m[0])) {
      seen.add(m[0])
      out.push(m[0])
    }
  }
  return out
}

function allUtteranceIds(text: string): string[] {
  return [...text.matchAll(UTTERANCE_ID_RE)].map(m => m[0])
}

// Utterance ids that appear between this learner's id and the next one (or the
// end of the text) — the "evidence block" for that learner, if the caller
// formatted the prompt as one block per learner (the expected shape once
// src/lib/placement.ts exists). Falls back to every utterance id in the whole
// prompt when the caller didn't group them, which still satisfies "cites an id
// that actually appeared in the prompt."
function utteranceIdsNear(text: string, learnerId: string): string[] {
  const start = text.indexOf(learnerId)
  if (start === -1) return []
  const rest = text.slice(start + learnerId.length)
  const next = rest.match(LEARNER_ID_RE)
  const end = next ? rest.indexOf(next[0]) : rest.length
  return allUtteranceIds(rest.slice(0, end))
}

function mockPlacements(text: string): unknown[] {
  const learnerIds = extractLearnerIds(text)
  const fallback = allUtteranceIds(text)
  return learnerIds.map((learnerId, i) => {
    const near = utteranceIdsNear(text, learnerId)
    const evidence = (near.length > 0 ? near : fallback).slice(0, 3)
    if (evidence.length === 0) {
      // Never invent an id — if the prompt genuinely cites none, that's a
      // caller bug (the prompt builder forgot the evidence block), and it
      // should fail loudly here rather than the mock quietly fabricating one.
      throw new Error(
        `mock provider: no utterance id found in the prompt for ${learnerId}; ` +
          "refusing to invent one for evidenceUtteranceIds"
      )
    }
    const band = BANDS[i % BANDS.length]
    const rationale =
      `Deterministic mock placement for ${learnerId}: band assigned by cycling the ` +
      `fixed band table against learner index ${i}, grounded in ${evidence.length} ` +
      "evidence utterance(s) from the prompt."
    return {
      learnerId,
      band,
      rationale: rationale.slice(0, 280),
      evidenceUtteranceIds: evidence,
    }
  })
}

// Mirrors the "WEEK NUMBER: <n>" / "HORIZON WEEKS: <n>" lines the weekly-pass
// route puts at the top of its prompt (see
// src/app/api/programs/[id]/advance/route.ts) so the mock can echo back a
// schema-valid, real week number and stay inside the program's horizon
// instead of guessing.
const WEEK_NUMBER_RE = /WEEK NUMBER:\s*(\d+)/
const HORIZON_WEEKS_RE = /HORIZON WEEKS:\s*(\d+)/

// Grounded the same way mockPlacements grounds evidenceUtteranceIds: every
// learner id the mock cites (atRisk, drafts[].learnerId) is copied out of the
// prompt text, never invented. onTrack/slipped are also grounded in real ids
// here for realism, even though the route overrides them with the
// code-computed completed/missed lists before persisting — the fields the
// route actually trusts from a live provider are atRisk, managerBrief,
// curriculumAdjustments and drafts, and those are what must never cite a
// fabricated learner.
function mockWeeklyPass(text: string): unknown {
  const learnerIds = extractLearnerIds(text)
  if (learnerIds.length === 0) {
    throw new Error(
      "mock provider: no learner id found in the prompt for the weekly pass; " +
        "refusing to invent one for onTrack/slipped/atRisk/drafts",
    )
  }

  const weekNumber = Number(text.match(WEEK_NUMBER_RE)?.[1] ?? "1")
  // Falls back to "no bound" (Infinity) when the route omits the line, so a
  // caller that doesn't supply HORIZON WEEKS (e.g. a hand-rolled test prompt)
  // still gets a next-week suggestion rather than a silently empty list.
  const horizonWeeks = Number(text.match(HORIZON_WEEKS_RE)?.[1] ?? String(Infinity))
  const half = Math.max(1, Math.floor(learnerIds.length / 2))
  const onTrack = learnerIds.slice(0, half)
  const slipped = learnerIds.slice(half)
  const atRisk = learnerIds.slice(0, 1)

  const draftLearners = learnerIds.slice(0, Math.min(2, learnerIds.length))
  const drafts = draftLearners.map((learnerId, i) => ({
    learnerId,
    channel: i % 2 === 0 ? "email" : "slack",
    subject: "Quick check-in on this week's practice",
    body:
      "Hi — noticed how this week's sessions went and wanted to check in. " +
      "No pressure at all, just here if you want to pick it back up.",
    reason: `Deterministic mock draft for ${learnerId}, grounded in this week's computed completion facts.`,
  }))

  // No valid next week left inside the horizon (this is the program's final
  // week) — propose nothing rather than a fabricated out-of-range target.
  // curriculumAdjustments has no minimum length in WeeklyPassSchema, so an
  // empty array is schema-valid.
  const nextWeek = weekNumber + 1
  const curriculumAdjustments = nextWeek <= horizonWeeks
    ? [{
        weekN: nextWeek,
        change: "Add one short roleplay drilling the sounds that came up most as misses this week.",
        reason: "Grounded in this week's most-missed-phonemes fact from the practice sessions.",
      }]
    : []

  return {
    weekNumber,
    onTrack,
    slipped,
    atRisk,
    managerBrief:
      `Week ${weekNumber} update: most of the team kept pace with this week's practice, and a ` +
      "few need a nudge to catch back up. We're watching a couple of specific areas closely " +
      "and adjusting next week's scenarios to match what actually came up in the sessions.",
    curriculumAdjustments,
    drafts,
  }
}

function isWeeklyPassSchema(node: unknown): boolean {
  const n = node as { type?: string; properties?: Record<string, unknown> } | null
  if (!n || n.type !== "object" || !n.properties) return false
  const props = n.properties
  return (
    "onTrack" in props && "slipped" in props && "atRisk" in props &&
    "managerBrief" in props && "curriculumAdjustments" in props && "drafts" in props
  )
}

function isPlacementArraySchema(node: unknown): boolean {
  const n = node as { type?: string; items?: { type?: string; properties?: Record<string, unknown> } } | null
  if (!n || n.type !== "array" || !n.items || n.items.type !== "object") return false
  const props = n.items.properties ?? {}
  return "learnerId" in props && "band" in props && "rationale" in props && "evidenceUtteranceIds" in props
}

// `plainLanguage` (SuccessCriterion) is rejected by src/lib/schemas.ts if it
// contains a bare CEFR-shaped token (A1/A2/B1/B2/C1/C2/CEFR) anywhere — the
// refine deliberately over-rejects, so this fixture avoids those characters
// entirely rather than trying to thread the needle.
function genString(path: string, node: { minLength?: number; maxLength?: number }): string {
  const last = path.split(".").pop() ?? path
  if (last === "plainLanguage") {
    return "Team members can now handle a rushed customer call without losing the thread."
  }
  if (last === "measurableProxy") {
    return "Share of calls where the customer only has to restate the issue once, tracked weekly."
  }
  let base = `mock-${last}-${fnv1a(path).toString(36)}`
  const min = node.minLength ?? 0
  while (base.length < min) base += "-x"
  if (typeof node.maxLength === "number" && base.length > node.maxLength) {
    base = base.slice(0, node.maxLength)
  }
  return base
}

type JsonSchemaNode = {
  type?: string
  enum?: unknown[]
  const?: unknown
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  items?: JsonSchemaNode
  minItems?: number
  maxItems?: number
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
}

function genFromSchema(node: JsonSchemaNode | undefined, path: string, ctx: { text: string }): unknown {
  if (!node) return null

  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return node.enum[fnv1a(path) % node.enum.length]
  }
  if ("const" in node) return node.const

  switch (node.type) {
    case "object": {
      if (isWeeklyPassSchema(node)) return mockWeeklyPass(ctx.text)
      const props = node.properties ?? {}
      const keys = node.required ?? Object.keys(props)
      const out: Record<string, unknown> = {}
      for (const key of keys) out[key] = genFromSchema(props[key], `${path}.${key}`, ctx)
      return out
    }
    case "array": {
      if (isPlacementArraySchema(node)) return mockPlacements(ctx.text)
      const min = node.minItems ?? 2
      const max = node.maxItems ?? Math.max(min, 2)
      const n = Math.min(Math.max(min, 1), max)
      return Array.from({ length: n }, (_, i) => genFromSchema(node.items, `${path}[${i}]`, ctx))
    }
    case "string":
      return genString(path, node)
    case "number":
    case "integer": {
      let v = (fnv1a(path) % 5) + 1
      if (typeof node.minimum === "number") v = Math.max(v, node.minimum)
      if (typeof node.maximum === "number") v = Math.min(v, node.maximum)
      return v
    }
    case "boolean":
      return fnv1a(path) % 2 === 0
    default:
      return null
  }
}

export const mockProvider: Provider = {
  name: "mock",
  async call({ system, prompt, toolName, jsonSchema }: ProviderCall) {
    // Search both system and prompt for learner/utterance ids — the fixed
    // policy text lives in `system`, the per-call grounded evidence in `prompt`.
    const text = `${system}\n${prompt}`
    const raw = genFromSchema(jsonSchema as JsonSchemaNode, toolName, { text })
    return { raw, cost: 0 }
  },
}
