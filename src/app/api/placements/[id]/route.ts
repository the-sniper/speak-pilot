import { eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/db"
import { placements } from "@/db/schema"
import { BANDS } from "@/lib/bands"
import { getPlacementEvidenceById } from "@/lib/evidence"

const OverrideBody = z.object({ overriddenBand: z.enum(BANDS) })

type RouteParams = { params: Promise<{ id: string }> }

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  const { id } = await params
  const evidence = await getPlacementEvidenceById(id)
  if (!evidence) {
    return NextResponse.json({ error: "placement not found" }, { status: 404 })
  }
  return NextResponse.json(evidence)
}

// Writes ONLY overriddenBand. `band` is the model's original verdict and is
// never touched by this route — the diff between `band` and `overriddenBand`
// is the product feature (and, in a real system, training signal), so a
// human override must never overwrite or shadow the model's original word.
export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const { id } = await params

  const body = await req.json().catch(() => null)
  const parsed = OverrideBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "overriddenBand must be one of " + BANDS.join(", ") }, { status: 400 })
  }

  const [existing] = await db.select({ id: placements.id }).from(placements).where(eq(placements.id, id)).limit(1)
  if (!existing) {
    return NextResponse.json({ error: "placement not found" }, { status: 404 })
  }

  await db
    .update(placements)
    .set({ overriddenBand: parsed.data.overriddenBand })
    .where(eq(placements.id, id))

  return NextResponse.json({ ok: true, overriddenBand: parsed.data.overriddenBand })
}
