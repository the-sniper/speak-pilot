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
