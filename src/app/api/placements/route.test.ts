import { describe, it, expect, beforeAll } from "vitest"
import { db } from "@/db"
import { placements } from "@/db/schema"
import { GET } from "./route"

let seeded: (typeof placements.$inferSelect)[]

beforeAll(async () => {
  seeded = await db.select().from(placements).limit(1)
  if (seeded.length === 0) {
    throw new Error("No placements seeded. Run a generation against the mock provider first.")
  }
})

describe("GET /api/placements?programId=&learnerId=", () => {
  it("resolves the placement id from (programId, learnerId) and returns the same evidence shape as GET /:id", async () => {
    const [p] = seeded
    const res = await GET(
      new Request(`http://x/api/placements?programId=${p.programId}&learnerId=${p.learnerId}`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(p.id)
    expect(body.programId).toBe(p.programId)
    expect(body.learnerId).toBe(p.learnerId)
  })

  it("400s when query params are missing", async () => {
    const res = await GET(new Request("http://x/api/placements"))
    expect(res.status).toBe(400)
  })

  it("404s on a valid but unknown (programId, learnerId) pair", async () => {
    const res = await GET(new Request("http://x/api/placements?programId=nope&learnerId=nope"))
    expect(res.status).toBe(404)
  })
})
