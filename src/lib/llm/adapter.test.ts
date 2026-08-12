import { describe, it, expect, vi } from "vitest"
import { z } from "zod"
import { callWithSchema, __setProviderForTest, __setRunSinkForTest } from "./adapter"

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
