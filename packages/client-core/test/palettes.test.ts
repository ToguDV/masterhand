import { describe, expect, it } from "vitest"
import { DEFAULT_PALETTE, PALETTES, resolvePalette, type PaletteID } from "../src/palettes"

describe("palettes (#124)", () => {
  it("defaults to emerald and falls back for unknown values", () => {
    expect(DEFAULT_PALETTE).toBe("emerald")
    expect(resolvePalette(null)).toBe("emerald")
    expect(resolvePalette("")).toBe("emerald")
    expect(resolvePalette("nope")).toBe("emerald")
    expect(resolvePalette("violet")).toBe("violet")
  })

  it("ships emerald plus 12 selectable themes", () => {
    const ids = Object.keys(PALETTES).sort()
    expect(ids).toEqual(
      [
        "amber",
        "blue",
        "crimson",
        "cyan",
        "emerald",
        "fuchsia",
        "indigo",
        "lime",
        "orange",
        "rose",
        "slate",
        "teal",
        "violet",
      ].sort(),
    )
  })

  it("gives every palette a label and a complete light/dark accent set", () => {
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
        ] as const) {
          expect(typeof accents[key]).toBe("string")
          expect(accents[key].length).toBeGreaterThan(0)
        }
      }
      // The two modes differ (a palette is not a single static color).
      expect(entry.light.accent).not.toBe(entry.dark.accent)
    }
    expect(labels.size).toBe(13)
  })

  it("keeps the emerald values the design system shipped with", () => {
    expect(PALETTES.emerald.light.accent).toBe("#0B6B53")
    expect(PALETTES.emerald.dark.accent).toBe("#3ED8A8")
    expect(PALETTES.emerald.light.bubbleUser).toBe("#085041")
    expect(PALETTES.emerald.dark.bubbleUser).toBe("#06372C")
  })

  it("accepts every known id through the resolver", () => {
    for (const id of Object.keys(PALETTES) as PaletteID[]) {
      expect(resolvePalette(id)).toBe(id)
    }
  })
})
