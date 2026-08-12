import { eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/db"
import { drafts } from "@/db/schema"

// Load-bearing constraint, not a comment: "sent" is not a member of this
// enum, so a PATCH attempting it fails schema validation and 400s before any
// write happens. Nothing in this route (or anywhere else in the system) can
// move a draft to a state that implies a message left the building.
const PatchBody = z.object({
  editedBody: z.string().optional(),
  status: z.enum(["draft", "approved"]).optional(),
})

type RouteParams = { params: Promise<{ id: string }> }

// Writes ONLY editedBody and/or status. `body` — what the model wrote — is
// never touched here, mirroring placements.band vs overriddenBand: the
// model's original stays immutable and recoverable, a human edit sits
// alongside it rather than overwriting it.
export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const { id } = await params

  const body = await req.json().catch(() => null)
  const parsed = PatchBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "editedBody must be a string and/or status must be one of draft, approved" },
      { status: 400 },
    )
  }

  const { editedBody, status } = parsed.data
  if (editedBody === undefined && status === undefined) {
    return NextResponse.json({ error: "provide editedBody and/or status to update" }, { status: 400 })
  }

  const [existing] = await db.select({ id: drafts.id }).from(drafts).where(eq(drafts.id, id)).limit(1)
  if (!existing) {
    return NextResponse.json({ error: "draft not found" }, { status: 404 })
  }

  const updates: { editedBody?: string; status?: "draft" | "approved" } = {}
  if (editedBody !== undefined) updates.editedBody = editedBody
  if (status !== undefined) updates.status = status

  await db.update(drafts).set(updates).where(eq(drafts.id, id))

  const [after] = await db.select().from(drafts).where(eq(drafts.id, id))
  return NextResponse.json(after)
}
