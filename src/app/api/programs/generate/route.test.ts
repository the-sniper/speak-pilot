import { describe, it, expect, beforeAll } from "vitest"
import { POST } from "./route"

async function collect(res: Response) {
  const text = await res.text()
  return text.split("\n\n").filter(Boolean).map(frame => {
    const ev = /event: (\w+)/.exec(frame)?.[1]
    const data = /data: (.*)/s.exec(frame)?.[1]
    return { event: ev, data: data ? JSON.parse(data) : null }
  })
}

describe("POST /api/programs/generate", () => {
  beforeAll(() => { process.env.LLM_PROVIDER = "mock" })

  it("emits the six sections in order, then done", async () => {
    const req = new Request("http://x/api/programs/generate", {
      method: "POST",
      body: JSON.stringify({ brief: "18 people on our Seoul support team. 10 weeks." }),
    })
    const frames = await collect(await POST(req))
    expect(frames.filter(f => f.event === "section").map(f => f.data.key)).toEqual([
      "cohort", "placements", "weeks", "cadence", "successCriteria", "kickoff",
    ])
    expect(frames.at(-1)!.event).toBe("done")
    expect(frames.at(-1)!.data.programId).toBeTruthy()
  })

  it("sets the SSE content type", async () => {
    const req = new Request("http://x/api/programs/generate", {
      method: "POST", body: JSON.stringify({ brief: "x" }),
    })
    expect((await POST(req)).headers.get("content-type")).toContain("text/event-stream")
  })

  it("emits one placement per seeded learner, each citing evidence", async () => {
    const req = new Request("http://x/api/programs/generate", {
      method: "POST", body: JSON.stringify({ brief: "18 people, Seoul support, 10 weeks" }),
    })
    const frames = await collect(await POST(req))
    const placements = frames.find(f => f.data?.key === "placements")!.data.payload
    expect(placements.length).toBe(24)
    for (const p of placements) expect(p.evidenceUtteranceIds.length).toBeGreaterThan(0)
  })
})
