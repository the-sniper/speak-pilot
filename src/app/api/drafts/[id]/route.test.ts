import { describe, it, expect, beforeAll } from "vitest"
import { PATCH } from "./route"
import { db } from "@/db"
import { drafts } from "@/db/schema"
import { eq } from "drizzle-orm"

let id: string
let originalBody: string

beforeAll(async () => {
  const [d] = await db.select().from(drafts).limit(1)
  if (!d) throw new Error("No drafts seeded. Run a generation and one advance against the mock provider first.")
  id = d.id
  originalBody = d.body
})

describe("PATCH /api/drafts/:id", () => {
  it("saves an edited body without destroying the original", async () => {
    const req = new Request("http://x", {
      method: "PATCH", body: JSON.stringify({ editedBody: "Rewritten by a human." }),
    })
    const res = await PATCH(req, { params: Promise.resolve({ id }) })
    expect(res.status).toBe(200)

    const [after] = await db.select().from(drafts).where(eq(drafts.id, id))
    expect(after.editedBody).toBe("Rewritten by a human.")
    expect(after.body).toBe(originalBody)          // the model's original is immutable
  })

  it("flips status to approved", async () => {
    const req = new Request("http://x", { method: "PATCH", body: JSON.stringify({ status: "approved" }) })
    const res = await PATCH(req, { params: Promise.resolve({ id }) })
    expect(res.status).toBe(200)

    const [after] = await db.select().from(drafts).where(eq(drafts.id, id))
    expect(after.status).toBe("approved")
  })

  it("REFUSES a status of 'sent' — nothing in this system sends mail", async () => {
    const req = new Request("http://x", { method: "PATCH", body: JSON.stringify({ status: "sent" }) })
    const res = await PATCH(req, { params: Promise.resolve({ id }) })
    expect(res.status).toBe(400)

    const [after] = await db.select().from(drafts).where(eq(drafts.id, id))
    expect(after.status).not.toBe("sent")
  })

  it("returns 404 for an unknown draft", async () => {
    const req = new Request("http://x", { method: "PATCH", body: JSON.stringify({ status: "approved" }) })
    const res = await PATCH(req, { params: Promise.resolve({ id: "no-such-draft" }) })
    expect(res.status).toBe(404)
  })
})
