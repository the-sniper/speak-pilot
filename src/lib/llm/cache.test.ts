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
