import { NextResponse } from "next/server"
import { getPlacementEvidenceByLearner } from "@/lib/evidence"

// The evidence panel opens from a placement card, which only knows
// (programId, learnerId) — the placement's own row id is generated at insert
// time and never sent to the client in the SSE `placements` section (that
// payload is the model's schema-validated output, not the persisted row).
// This is the one lookup that bridges the two: same `getPlacementEvidenceByLearner`
// query the [id] route's sibling function shares a single join with (see
// src/lib/evidence.ts) — no second copy of the evidence query exists here.
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const programId = url.searchParams.get("programId")
  const learnerId = url.searchParams.get("learnerId")
  if (!programId || !learnerId) {
    return NextResponse.json(
      { error: "programId and learnerId query params are required" },
      { status: 400 },
    )
  }

  const evidence = await getPlacementEvidenceByLearner(programId, learnerId)
  if (!evidence) {
    return NextResponse.json({ error: "placement not found" }, { status: 404 })
  }
  return NextResponse.json(evidence)
}
