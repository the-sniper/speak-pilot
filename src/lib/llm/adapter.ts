import crypto from "crypto"
import { z } from "zod"
import { CACHE_DIR, cacheKey, readCache, writeCache } from "./cache"
import { anthropicProvider } from "./providers/anthropic"
import { mockProvider } from "./providers/mock"
import { openaiProvider } from "./providers/openai"
import type { Provider } from "./providers/types"

// Shape of one row this adapter writes to the `agent_runs` table (src/db/schema.ts).
// Every attempt gets a row — successes AND failures — because the Evals tab is a
// query over this table and a swallowed failure would become a missing metric.
export type RunRow = {
  id: string
  kind: string
  provider: string
  model: string
  briefLabel: string | null
  input: unknown
  output: unknown
  ok: boolean
  attempt: number
  error: string | null
  cacheHit: boolean
  latencyMs: number
  cost: number
  createdAt: Date
}

function resolveProvider(): Provider {
  const name = (process.env.LLM_PROVIDER ?? "mock").toLowerCase()
  if (name === "openai") return openaiProvider
  if (name === "anthropic") return anthropicProvider
  return mockProvider
}

let currentProvider: Provider = resolveProvider()

// The on-disk replay cache is only consulted for the real, env-selected
// provider. Once a test injects a fake provider, caching is switched off for
// the module's lifetime — the four adapter tests all use the literal strings
// "s"/"p"/"t" with different fake behaviors, and a shared cache keyed only on
// (system, prompt, toolName, model) would let one test's fixture leak into the
// next. This also means unit tests never write into the real .llm-cache/
// directory, so the committed replay corpus can't be accidentally polluted by
// a test run.
let cacheEnabled = true

async function defaultRunSink(row: RunRow): Promise<void> {
  const { db } = await import("@/db")
  const { agentRuns } = await import("@/db/schema")
  await db.insert(agentRuns).values(row)
}

// The sink's return value is ignored (we only ever `await` it for sequencing) —
// typed as `unknown` rather than `void` so a test double like
// `r => runs.push(r)` (whose expression body returns the new array length)
// doesn't need an explicit `void` wrapper to satisfy the type checker.
let runSink: (row: RunRow) => unknown = defaultRunSink

/** Test seam — inject a fake provider so adapter tests need no network. */
export function __setProviderForTest(p: Provider): void {
  currentProvider = p
  cacheEnabled = false
}

/** Test seam — capture agent_runs rows in memory so adapter tests need no DB. */
export function __setRunSinkForTest(fn: (row: RunRow) => unknown): void {
  runSink = fn
}

// --- JSON Schema conversion --------------------------------------------------

// Zod 4 ships z.toJSONSchema natively — used here rather than a hand-rolled
// converter. For every schema in src/lib/schemas.ts (none of which use
// .optional()) it already emits `additionalProperties: false` plus a
// `required` array covering every key at each object level, which is exactly
// what OpenAI's strict function-calling mode requires. This walk re-asserts
// both recursively as a safety net — for any future schema that does add an
// optional field, OpenAI strict mode still needs that field listed in
// `required` (typed as nullable/union, not simply omitted) and
// additionalProperties:false at every nesting level, not just the root — and
// strips the `$schema` key, which providers don't expect on a tool's
// input_schema/parameters.
function enforceStrict(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(enforceStrict)
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "$schema") continue
      out[k] = enforceStrict(v)
    }
    if (out.type === "object" && out.properties && typeof out.properties === "object") {
      out.additionalProperties = false
      out.required = Object.keys(out.properties as Record<string, unknown>)
    }
    return out
  }
  return node
}

export function toStrictJsonSchema(schema: z.ZodType): object {
  return enforceStrict(z.toJSONSchema(schema)) as object
}

// --- Adapter ------------------------------------------------------------------

export async function callWithSchema<T>(args: {
  prompt: string
  system: string
  schema: z.ZodType<T>
  toolName: string
  kind: string
  briefLabel?: string
  maxRetries?: number
}): Promise<{ data: T; runId: string; latencyMs: number; cost: number; cacheHit: boolean }> {
  const { prompt, system, schema, toolName, kind, briefLabel, maxRetries = 1 } = args
  const provider = currentProvider
  const model = process.env.LLM_MODEL ?? "mock-model"
  const jsonSchema = toStrictJsonSchema(schema)
  const key = cacheKey(system, prompt, toolName, model)

  if (cacheEnabled) {
    // Throws CacheMissInReplayError when REPLAY=1 and there's no entry — this
    // is the guarantee that the deployed demo never calls a live provider.
    const cached = readCache(CACHE_DIR, key)
    if (cached !== null) {
      const parsed = schema.safeParse(cached)
      if (parsed.success) {
        const runId = crypto.randomUUID()
        await runSink({
          id: runId,
          kind,
          provider: provider.name,
          model,
          briefLabel: briefLabel ?? null,
          input: { system, prompt, toolName },
          output: cached,
          ok: true,
          attempt: 1,
          error: null,
          cacheHit: true,
          latencyMs: 0,
          cost: 0,
          createdAt: new Date(),
        })
        return { data: parsed.data, runId, latencyMs: 0, cost: 0, cacheHit: true }
      }
      // A cached blob that no longer validates is a bug in whatever run wrote
      // it, not something to serve — fall through and regenerate live.
    }
  }

  let currentPrompt = prompt
  const totalAttempts = 1 + maxRetries
  let lastErrorText = ""

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const started = Date.now()
    const { raw, cost } = await provider.call({ system, prompt: currentPrompt, toolName, jsonSchema, model })
    const latencyMs = Date.now() - started
    const parsed = schema.safeParse(raw)
    const runId = crypto.randomUUID()

    if (parsed.success) {
      await runSink({
        id: runId,
        kind,
        provider: provider.name,
        model,
        briefLabel: briefLabel ?? null,
        input: { system, prompt: currentPrompt, toolName },
        output: raw,
        ok: true,
        attempt,
        error: null,
        cacheHit: false,
        latencyMs,
        cost,
        createdAt: new Date(),
      })
      if (cacheEnabled) writeCache(CACHE_DIR, key, raw)
      return { data: parsed.data, runId, latencyMs, cost, cacheHit: false }
    }

    lastErrorText = parsed.error.message
    await runSink({
      id: runId,
      kind,
      provider: provider.name,
      model,
      briefLabel: briefLabel ?? null,
      input: { system, prompt: currentPrompt, toolName },
      output: raw,
      ok: false,
      attempt,
      error: lastErrorText,
      cacheHit: false,
      latencyMs,
      cost,
      createdAt: new Date(),
    })

    if (attempt < totalAttempts) {
      currentPrompt = `${currentPrompt}\n\nYour previous output failed validation:\n${lastErrorText}\nReturn output matching the schema exactly.`
    }
  }

  throw new Error(`callWithSchema: ${toolName} failed schema validation after ${totalAttempts} attempt(s): ${lastErrorText}`)
}
