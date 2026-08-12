import crypto from "crypto"
import { z } from "zod"
import { CACHE_DIR, CacheMissInReplayError, cacheKey, readCache, writeCache } from "./cache"
import { anthropicProvider } from "./providers/anthropic"
import { mockProvider } from "./providers/mock"
import { openaiProvider } from "./providers/openai"
import type { Provider } from "./providers/types"

// Shape of one row this adapter writes to the `agent_runs` table (src/db/schema.ts).
// Every attempt gets a row — successes AND failures — because the Evals tab is a
// query over this table and a swallowed failure would become a missing metric.
//
// `cost` is nullable: `0` means genuinely free (mock provider, cache hit — no
// API call happened, so $0 is a measurement, not a guess). `null` means "a
// real call happened on a model whose price we haven't verified" — the Evals
// tab must render that as "cost unknown", never as $0.00, or an unpriced
// OpenAI call would read as free next to real Anthropic-priced rows.
export type RunRow = {
  id: string
  kind: string
  provider: string
  model: string
  briefLabel: string | null
  // Which eval-sweep run wrote this row, null for ordinary (non-eval) calls —
  // same nullable-tag pattern as briefLabel. See the sweepId comment on
  // agentRuns in src/db/schema.ts for why this exists: without it, the Evals
  // tab has no way to show exactly one sweep's numbers instead of pooling
  // every sweep ever run together.
  sweepId: string | null
  input: unknown
  output: unknown
  ok: boolean
  attempt: number
  error: string | null
  cacheHit: boolean
  latencyMs: number
  cost: number | null
  createdAt: Date
}

function resolveProvider(): Provider {
  const name = (process.env.LLM_PROVIDER ?? "mock").toLowerCase()
  if (name === "openai") return openaiProvider
  if (name === "anthropic") return anthropicProvider
  return mockProvider
}

let currentProvider: Provider = resolveProvider()
let usingTestProvider = false

// The on-disk replay cache is normally CACHE_DIR (the committed .llm-cache/
// corpus). `null` means "cache disabled" and is the default the moment a test
// injects a fake provider (see __setProviderForTest) — the four core adapter
// tests all use the literal strings "s"/"p"/"t" with different fake
// behaviors, and a shared cache keyed only on (system, prompt, toolName,
// model) would let one test's fixture leak into the next. This also means
// ordinary unit tests never write into the real .llm-cache/ directory, so the
// committed replay corpus can't be accidentally polluted by a test run.
//
// __setCacheDirForTest lets a test opt back into exercising the cache layer
// (e.g. to prove REPLAY behavior end-to-end) while pointing it at a temp
// directory instead of CACHE_DIR — see adapter.test.ts's REPLAY regression
// test for the pattern.
let testCacheDir: string | null = null

// Code review fix round 1, Finding 1f: this used to gate only on "was a fake
// provider injected for a test," which left a real gap -- the ordinary,
// non-test path with LLM_PROVIDER=mock (the project's default, see .env)
// still resolved to the real committed CACHE_DIR and wrote mock fixtures
// into it. The mock provider is deterministic and returns near-instantly, so
// caching it buys nothing; the only effect was a shared corpus polluted with
// synthetic output that a real provider could later collide with and serve
// as if it were genuine (see cacheKey's provider dimension, added in the
// same fix, which closes the collision itself -- this closes the "why does
// mock output end up in the corpus at all" question). testCacheDir still
// takes priority so a regression test can deliberately exercise the real
// cache-read/write path (with a fake provider name) against a temp
// directory, same pattern as the REPLAY-stale-cache test below.
function activeCacheDir(): string | null {
  if (testCacheDir !== null) return testCacheDir
  if (usingTestProvider) return null
  if (currentProvider === mockProvider) return null
  return CACHE_DIR
}

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
  usingTestProvider = true
}

/** Test seam — capture agent_runs rows in memory so adapter tests need no DB. */
export function __setRunSinkForTest(fn: (row: RunRow) => unknown): void {
  runSink = fn
}

/**
 * Test seam — point the replay cache at a temp directory instead of the real
 * CACHE_DIR (or, with `null`, disable it again). Independent of
 * __setProviderForTest: setting a dir here re-enables caching even when a
 * fake provider is active, which is what a REPLAY regression test needs — the
 * cache layer must be exercised for real, against a directory that is never
 * the committed .llm-cache/ corpus.
 */
export function __setCacheDirForTest(dir: string | null): void {
  testCacheDir = dir
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
  sweepId?: string
  maxRetries?: number
}): Promise<{ data: T; runId: string; latencyMs: number; cost: number | null; cacheHit: boolean }> {
  const { prompt, system, schema, toolName, kind, briefLabel, sweepId, maxRetries = 1 } = args
  const provider = currentProvider
  const model = process.env.LLM_MODEL ?? "mock-model"
  const jsonSchema = toStrictJsonSchema(schema)
  const key = cacheKey(system, prompt, toolName, model, provider.name)
  const cacheDir = activeCacheDir()

  if (cacheDir !== null) {
    // Throws CacheMissInReplayError when REPLAY=1 and there's no file at all —
    // this is the guarantee that the deployed demo never calls a live
    // provider. That is only half the guarantee, though: a file CAN exist and
    // still fail to parse against the current schema (a later task tightens a
    // schema; the committed .llm-cache/ corpus goes stale). Falling through to
    // a live call in that case would silently defeat REPLAY on exactly the
    // realistic trigger this flag exists to prevent — so a present-but-invalid
    // entry under REPLAY is fatal too, not a reason to regenerate.
    const cached = readCache(cacheDir, key)
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
          sweepId: sweepId ?? null,
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
      if (process.env.REPLAY === "1") {
        throw new CacheMissInReplayError(key, parsed.error.message)
      }
      // Not under REPLAY: a cached blob that no longer validates is a bug in
      // whatever run wrote it, not something to serve — fall through and
      // regenerate live, since a real provider is actually reachable here.
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
        sweepId: sweepId ?? null,
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
      if (cacheDir !== null) writeCache(cacheDir, key, raw)
      return { data: parsed.data, runId, latencyMs, cost, cacheHit: false }
    }

    lastErrorText = parsed.error.message
    await runSink({
      id: runId,
      kind,
      provider: provider.name,
      model,
      briefLabel: briefLabel ?? null,
      sweepId: sweepId ?? null,
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
