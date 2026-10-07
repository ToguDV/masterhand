import { describe, expect, it } from "vitest"
import { DEFAULT_PALETTE, PALETTES, resolvePalette, type PaletteID } from "../src/palettes"

describe("palettes (color themes)", () => {
  it("defaults to paper and falls back for unknown values", () => {
    expect(DEFAULT_PALETTE).toBe("paper")
    expect(resolvePalette(null)).toBe("paper")
    expect(resolvePalette("")).toBe("paper")
    expect(resolvePalette("nope")).toBe("paper")
    expect(resolvePalette("dracula")).toBe("dracula")
    // Legacy accent ids fall back to the default theme.
    expect(resolvePalette("emerald")).toBe("paper")
    expect(resolvePalette("violet")).toBe("paper")
  })

  it("ships paper plus 12 named color themes", () => {
    const ids = Object.keys(PALETTES).sort()
    expect(ids).toEqual(
      [
        "ayu",
        "catppuccin",
        "dracula",
        "everforest",
        "gruvbox",
        "monokai",
        "nord",
        "one-dark",
        "paper",
        "rose-pine",
        "solarized",
        "synthwave-84",
        "tokyo-night",
      ].sort(),
    )
  })

  it("gives every theme a label and a complete light/dark token set", () => {
    const labels = new Set<string>()
    for (const [id, entry] of Object.entries(PALETTES)) {
      expect(entry.label.length).toBeGreaterThan(0)
      expect(labels.has(entry.label)).toBe(false)
      labels.add(entry.label)
      for (const mode of ["light", "dark"] as const) {
        const accents = entry[mode]
        for (const key of [
          "accent",
          "accentStrong",
          "accentSoft",
          "accentLine",
          "onAccent",
          "bubbleUser",
          "bubbleUserText",
          "surfaceMuted",
          "blob",
          "selection",
          "canvas",
          "surface",
          "text",
          "textSoft",
          "textMuted",
          "textFaint",
          "hairline",
          "hairlineStrong",
          "codeSurface",
          "codeSurfaceSoft",
          "synKeyword",
          "synString",
          "synNumber",
          "synComment",
          "synType",
        ] as const) {
          expect(typeof accents[key]).toBe("string")
          expect(accents[key].length).toBeGreaterThan(0)
        }
      }
      // The two modes differ (a theme is not a single static color).
      expect(entry.light.accent).not.toBe(entry.dark.accent)
      expect(entry.light.canvas).not.toBe(entry.dark.canvas)
    }
    expect(labels.size).toBe(13)
  })

  it("keeps the paper values the design system shipped with", () => {
    expect(PALETTES.paper.light.accent).toBe("#0B6B53")
    expect(PALETTES.paper.dark.accent).toBe("#3ED8A8")
    expect(PALETTES.paper.light.bubbleUser).toBe("#085041")
    expect(PALETTES.paper.dark.bubbleUser).toBe("#06372C")
    expect(PALETTES.paper.light.canvas).toBe("#FAFAF7")
    expect(PALETTES.paper.dark.canvas).toBe("#0C0C0B")
  })

  it("accepts every known id through the resolver", () => {
    for (const id of Object.keys(PALETTES) as PaletteID[]) {
      expect(resolvePalette(id)).toBe(id)
    }
  })
})
