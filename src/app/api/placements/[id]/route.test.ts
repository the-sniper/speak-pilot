import { describe, it, expect, beforeAll } from "vitest"
import { eq } from "drizzle-orm"
import { db } from "@/db"
import { placements } from "@/db/schema"
import { GET, PATCH } from "./route"

// Never `it.skip` on empty seed data — that reports green while asserting
// nothing. If this throws, run one generation against the mock provider
// (LLM_PROVIDER=mock) to seed real placements before running this suite.
let seeded: (typeof placements.$inferSelect)[]

beforeAll(async () => {
  seeded = await db.select().from(placements).limit(5)
  if (seeded.length === 0) {
    throw new Error("No placements seeded. Run a generation against the mock provider first.")
  }
})

describe("PATCH /api/placements/:id", () => {
  it("writes overriddenBand and NEVER touches the model's original band", async () => {
    const [before] = await db.select().from(placements).limit(1)
    const req = new Request("http://x", { method: "PATCH", body: JSON.stringify({ overriddenBand: "C1" }) })
    const res = await PATCH(req, { params: Promise.resolve({ id: before.id }) })
    expect(res.status).toBe(200)

    const [after] = await db.select().from(placements).where(eq(placements.id, before.id))
    expect(after.overriddenBand).toBe("C1")
    expect(after.band).toBe(before.band) // the model's word is immutable
    expect(after.rationale).toBe(before.rationale)
  })

  it("rejects a band outside the enum", async () => {
    const [p] = await db.select().from(placements).limit(1)
    const req = new Request("http://x", { method: "PATCH", body: JSON.stringify({ overriddenBand: "Z9" }) })
    const res = await PATCH(req, { params: Promise.resolve({ id: p.id }) })
    expect(res.status).toBe(400)
  })

  it("rejects a missing body", async () => {
    const [p] = await db.select().from(placements).limit(1)
    const req = new Request("http://x", { method: "PATCH", body: JSON.stringify({}) })
    const res = await PATCH(req, { params: Promise.resolve({ id: p.id }) })
    expect(res.status).toBe(400)
  })

  it("404s on an unknown placement id", async () => {
    const req = new Request("http://x", { method: "PATCH", body: JSON.stringify({ overriddenBand: "B1" }) })
    const res = await PATCH(req, { params: Promise.resolve({ id: "not-a-real-id" }) })
    expect(res.status).toBe(404)
  })

  it("does not touch overriddenBand when validation fails", async () => {
    const [p] = await db.select().from(placements).limit(1)
    const before = p.overriddenBand
    const req = new Request("http://x", { method: "PATCH", body: JSON.stringify({ overriddenBand: "nope" }) })
    await PATCH(req, { params: Promise.resolve({ id: p.id }) })
    const [after] = await db.select().from(placements).where(eq(placements.id, p.id))
    expect(after.overriddenBand).toBe(before)
  })
})

describe("GET /api/placements/:id", () => {
  it("returns full evidence: learner, utterances, word/phoneme scores, and expert verdicts", async () => {
    const [p] = await db.select().from(placements).limit(1)
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: p.id }) })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.id).toBe(p.id)
    expect(body.learnerId).toBe(p.learnerId)
    expect(body.band).toBe(p.band)
    expect(body.rationale).toBe(p.rationale)
    expect(Array.isArray(body.evidenceUtteranceIds)).toBe(true)
    expect(body.learner).toBeTruthy()
    expect(body.learner.id).toBe(p.learnerId)

    expect(Array.isArray(body.utterances)).toBe(true)
    expect(body.utterances.length).toBeGreaterThan(0)
    const utt = body.utterances[0]
    expect(typeof utt.audioPath).toBe("string")
    expect(Array.isArray(utt.words)).toBe(true)
    expect(Array.isArray(utt.expertScores)).toBe(true)
    expect(utt.expertScores.length).toBeGreaterThan(0)

    if (utt.words.length > 0) {
      const word = utt.words[0]
      expect(Array.isArray(word.phonemes)).toBe(true)
      if (word.phonemes.length > 0) {
        const phone = word.phonemes[0]
        expect(Array.isArray(phone.scores)).toBe(true)
        expect(phone.scores.length).toBeGreaterThan(0)
        expect(typeof phone.disagreement).toBe("number")
        expect(Array.isArray(phone.insertionsAfter)).toBe(true)
      }
    }
  })

  it("404s on an unknown placement id", async () => {
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "not-a-real-id" }) })
    expect(res.status).toBe(404)
  })
})
