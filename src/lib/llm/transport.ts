// OpenAI's and Anthropic's tool/function-calling protocols both require the
// top-level parameters/input_schema to describe a JSON *object* — a function
// call's arguments (OpenAI) or a tool_use block's input (Anthropic) are
// always a single JSON object, never a bare array, regardless of what the
// underlying Zod schema actually validates. groundedPlacementsSchema
// (src/lib/grounding.ts) is array-rooted at the type level because that's
// what the value genuinely is — an array of placements — and reshaping it
// (plus every caller that already expects an array back from
// callWithSchema) around a transport constraint would be the tail wagging
// the dog. Instead, a real provider wraps an array-rooted schema in a
// single-property object {"items": [...]} only for what's sent over the
// wire, and unwraps the response the moment it comes back, before it's ever
// handed to schema.safeParse.
//
// Caught by Task 15's smoke test: brief 1's placements call against real
// OpenAI failed with "schema must be a JSON Schema of 'type: object', got
// 'type: array'" before a single dollar was spent on the full 20-brief
// sweep — this is exactly the failure mode the smoke-test-before-sweep step
// exists to catch.
//
// Lives in its own module rather than adapter.ts: adapter.ts imports both
// providers/openai.ts and providers/anthropic.ts (to resolve the active
// provider), so those files importing helpers back from adapter.ts would be
// a circular import. Deliberately NOT applied inside
// callWithSchema/toStrictJsonSchema either: the mock provider
// (providers/mock.ts) walks the raw jsonSchema structurally and already
// handles an array root natively (isPlacementArraySchema) — it must never
// see this wrapping, so it's opt-in per real provider instead.
export function wrapArraySchemaForTransport(jsonSchema: object): { schema: object; wrapped: boolean } {
  if ((jsonSchema as { type?: string }).type !== "array") return { schema: jsonSchema, wrapped: false }
  return {
    schema: {
      type: "object",
      properties: { items: jsonSchema },
      required: ["items"],
      additionalProperties: false,
    },
    wrapped: true,
  }
}

export function unwrapArrayTransportResponse(raw: unknown, wrapped: boolean): unknown {
  if (!wrapped) return raw
  return (raw as { items?: unknown } | null)?.items
}
