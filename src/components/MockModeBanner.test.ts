import { describe, it, expect } from "vitest"
import { MOCK_MODE_TEXT } from "./MockModeBanner"

describe("mock mode banner copy", () => {
  it("says the content is placeholder output, not model output", () => {
    expect(MOCK_MODE_TEXT).toContain("placeholder output")
    expect(MOCK_MODE_TEXT).toContain("not model output")
  })

  it("names the built-in mock provider as the source", () => {
    expect(MOCK_MODE_TEXT).toMatch(/mock provider/i)
  })

  it("gives the exact command to see real cached responses instead", () => {
    expect(MOCK_MODE_TEXT).toContain("LLM_PROVIDER=openai LLM_API_KEY= REPLAY=1 npm run dev")
  })
})
