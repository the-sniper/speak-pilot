import { describe, expect, it } from "vitest"
import { unwrapArrayTransportResponse, wrapArraySchemaForTransport } from "./transport"

// Regression test for the bug Task 15's smoke test caught: OpenAI (and
// Anthropic) reject a tool schema whose root `type` is "array" — function
// call arguments / tool_use input must always be a JSON object. See the
// doc comment on wrapArraySchemaForTransport for the full story.
describe("wrapArraySchemaForTransport", () => {
  it("wraps an array-rooted schema in a single-property object", () => {
    const arraySchema = { type: "array", items: { type: "object", properties: { n: { type: "number" } } } }
    const { schema, wrapped } = wrapArraySchemaForTransport(arraySchema)
    expect(wrapped).toBe(true)
    expect(schema).toEqual({
      type: "object",
      properties: { items: arraySchema },
      required: ["items"],
      additionalProperties: false,
    })
  })

  it("leaves an object-rooted schema untouched", () => {
    const objectSchema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] }
    const { schema, wrapped } = wrapArraySchemaForTransport(objectSchema)
    expect(wrapped).toBe(false)
    expect(schema).toBe(objectSchema)
  })
})

describe("unwrapArrayTransportResponse", () => {
  it("unwraps {items: [...]} back to the bare array when wrapped is true", () => {
    expect(unwrapArrayTransportResponse({ items: [1, 2, 3] }, true)).toEqual([1, 2, 3])
  })

  it("passes the response through unchanged when wrapped is false", () => {
    const obj = { n: 1 }
    expect(unwrapArrayTransportResponse(obj, false)).toBe(obj)
  })
})
