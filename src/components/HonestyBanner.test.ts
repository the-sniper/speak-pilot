import { describe, it, expect } from "vitest"
import { HONESTY_TEXT } from "./HonestyBanner"

describe("honesty banner copy", () => {
  it("names the corpus and its licence", () => {
    expect(HONESTY_TEXT).toContain("speechocean762")
    expect(HONESTY_TEXT).toContain("CC BY 4.0")
  })

  it("discloses that the trajectory is constructed", () => {
    expect(HONESTY_TEXT).toContain("constructed")
    expect(HONESTY_TEXT).toContain("simulated by ordering real utterances")
  })

  it("states that placement accuracy is NOT simulated", () => {
    expect(HONESTY_TEXT).toMatch(/measured against real expert consensus and is not simulated/)
  })

  it("marks the org as fictional", () => {
    expect(HONESTY_TEXT).toContain("fictional")
  })
})
