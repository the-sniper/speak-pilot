import { NextResponse } from "next/server"
import { loadEvalsSummary } from "@/lib/evals"

export const runtime = "nodejs"

// JSON view over the same query+scoring layer src/app/evals/page.tsx renders
// server-side — exists as its own endpoint so the eval numbers are inspectable
// independent of the page (curl, a script, a future dashboard) without a
// second, driftable copy of loadEvalsSummary's logic.
export async function GET(): Promise<Response> {
  const summary = await loadEvalsSummary()
  return NextResponse.json(summary)
}
