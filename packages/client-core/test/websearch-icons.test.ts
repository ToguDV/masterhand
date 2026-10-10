import { describe, expect, it } from "vitest"
import { websearchIcon } from "../src/websearch-icons"
import { WEBSEARCH_SOURCE_IDS } from "../src/websearch"

describe("websearchIcon", () => {
  it("vendors a real brand mark for every built-in web search source", () => {
    for (const id of WEBSEARCH_SOURCE_IDS) {
      const svg = websearchIcon(id)
      expect(svg).toContain("<svg")
      expect(svg).toContain("viewBox=")
    }
    // Ids are matched tolerantly (case/whitespace).
    expect(websearchIcon(" Tavily ")).toBe(websearchIcon("tavily"))
    expect(websearchIcon("not-a-source")).toBeNull()
  })

  it("keeps normalized paints so one asset works on both themes", () => {
    for (const id of WEBSEARCH_SOURCE_IDS) {
      const svg = websearchIcon(id)!
      expect(svg.startsWith("<svg")).toBe(true)
      expect(svg.endsWith("</svg>")).toBe(true)
      // Every painted fill/stroke must resolve to the client's current color.
      expect(svg).not.toMatch(/\sfill="(?!none|currentColor)[^"]*"/)
      expect(svg).not.toMatch(/\sstroke="(?!none|currentColor)[^"]*"/)
      // Sized by the caller: no fixed width/height on the artwork.
      expect(svg).not.toMatch(/\swidth=/)
      expect(svg).not.toMatch(/\sheight=/)
      // Vector only: no embedded raster fallback.
      expect(svg).not.toContain("<image")
      expect(svg).not.toContain("base64")
    }
  })
})
