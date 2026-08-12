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
    expect(cacheKey("s", "p", "t", "m", "prov")).toBe(cacheKey("s", "p", "t", "m", "prov"))
  })
  it("changes when any component changes", () => {
    const base = cacheKey("s", "p", "t", "m", "prov")
    expect(cacheKey("s2", "p", "t", "m", "prov")).not.toBe(base)
    expect(cacheKey("s", "p2", "t", "m", "prov")).not.toBe(base)
    expect(cacheKey("s", "p", "t2", "m", "prov")).not.toBe(base)
    expect(cacheKey("s", "p", "t", "m2", "prov")).not.toBe(base)
  })
  // Code review fix round 1, Finding 1a: provider identity must be part of
  // the hash, not just the model string. Without this, an identical
  // (system, prompt, toolName, model) tuple from two different providers
  // (e.g. the mock provider and a real "openai" call sharing LLM_MODEL)
  // collides on one cache file -- a mock fixture would then be served, and
  // logged in agent_runs, as that OTHER provider's genuine measured output.
  it("changes when only the provider changes — this is the fix for the mock/real collision", () => {
    const asMock = cacheKey("s", "p", "t", "m", "mock")
    const asOpenai = cacheKey("s", "p", "t", "m", "openai")
    expect(asMock).not.toBe(asOpenai)
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
