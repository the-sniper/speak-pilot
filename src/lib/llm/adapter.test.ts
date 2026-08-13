import { describe, it, expect, vi } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import { z } from "zod"
import { callWithSchema, __setProviderForTest, __setRunSinkForTest, __setCacheDirForTest } from "./adapter"
import { CacheMissInReplayError, cacheKey, writeCache } from "./cache"

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

// Regression, found by Task 15's real OpenAI sweep: brief 9 failed with
// "fetch failed" (a network error thrown INSIDE provider.call(), before it
// ever returns {raw, cost}) and that sweep's agent_runs had ZERO ok=false
// rows despite the genuine failure — the exception skipped both runSink call
// sites in the retry loop entirely, so the failure log the Evals tab renders
// was blind to transport errors, and the sweep script's own printed claim
// ("Every attempt (success and failure) was written to agent_runs") was
// false for exactly this case.
describe("callWithSchema — transport errors (provider.call() throwing) are logged and retried like any other failure", () => {
  it("logs an ok=false row with the transport error's message when provider.call() throws, then retries and can still succeed", async () => {
    let call = 0
    __setProviderForTest({
      name: "fake",
      call: async () => {
        call++
        if (call === 1) throw new Error("fetch failed")
        return { raw: { n: 1 }, cost: 0.01 }
      },
    })
    const runs: any[] = []; __setRunSinkForTest(r => runs.push(r))
    const out = await callWithSchema({ prompt: "p", system: "s", schema: S, toolName: "t", kind: "test" })

    expect(out.data).toEqual({ n: 1 })
    expect(runs).toHaveLength(2)
    expect(runs[0].ok).toBe(false)
    expect(runs[0].error).toBe("fetch failed")
    expect(runs[0].output).toBeNull()   // no response body exists to show
    expect(runs[0].cost).toBeNull()     // no call completed, so cost is unknown, never $0
    expect(runs[1].ok).toBe(true)
  })

  it("logs an ok=false row on EVERY attempt and still throws when every attempt is a transport error", async () => {
    __setProviderForTest({ name: "fake", call: async () => { throw new Error("connection reset") } })
    const runs: any[] = []; __setRunSinkForTest(r => runs.push(r))
    await expect(
      callWithSchema({ prompt: "p", system: "s", schema: S, toolName: "t", kind: "test" })
    ).rejects.toThrow(/connection reset/)
    expect(runs).toHaveLength(2)          // one row per attempt (1 + default maxRetries)
    expect(runs.every(r => !r.ok)).toBe(true)
    expect(runs.every(r => r.error === "connection reset")).toBe(true)
  })
})

// Code review fix round 1, Finding 1 (Critical): readCache only throws
// CacheMissInReplayError when the cache FILE IS ABSENT. A file that exists but
// no longer validates against the current schema (e.g. a later task tightens
// it and the committed .llm-cache/ corpus goes stale) fell through to a live
// provider call with REPLAY=1 set — silently defeating the one guarantee that
// makes the deployed demo work with no API key. This is a persisted
// regression test, not a throwaway: it uses __setCacheDirForTest to exercise
// the real cache-read path end to end (not the __setProviderForTest-disables-
// caching path the four tests above use) against a temp directory, so it
// never touches the committed .llm-cache/ corpus.
describe("callWithSchema — REPLAY with a stale cache entry (regression)", () => {
  it("throws under REPLAY=1 and NEVER calls the provider when the cached entry no longer matches the schema", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmcache-replay-stale-"))
    const model = process.env.LLM_MODEL ?? "mock-model"
    const system = "replay-stale-system"
    const prompt = "replay-stale-prompt"
    const toolName = "replay-stale-tool"
    const providerName = "counting-fake"
    const key = cacheKey(system, prompt, toolName, model, providerName)
    // Simulates a schema that tightened after this entry was recorded — the
    // file exists, but { n: "not a number" } no longer satisfies S.
    writeCache(dir, key, { n: "not a number" })

    let providerCallCount = 0
    __setProviderForTest({
      name: providerName,
      call: async () => {
        providerCallCount++
        return { raw: { n: 1 }, cost: 0 }
      },
    })
    __setRunSinkForTest(() => {})
    __setCacheDirForTest(dir)
    process.env.REPLAY = "1"

    try {
      await expect(
        callWithSchema({ prompt, system, schema: S, toolName, kind: "test" })
      ).rejects.toThrow(CacheMissInReplayError)
      // This is the assertion that actually guards the guarantee — an
      // assertion that it merely throws would still pass if the provider had
      // been called first and something else threw afterward.
      expect(providerCallCount).toBe(0)
    } finally {
      delete process.env.REPLAY
      __setCacheDirForTest(null)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
