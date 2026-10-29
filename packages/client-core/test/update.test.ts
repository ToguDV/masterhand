import { describe, expect, it } from "vitest"
import {
  androidVersionCode,
  compareSemver,
  isNewerVersion,
  isSemver,
  normalizeUpdateCheck,
  normalizeVersionManifest,
} from "../src/update"

describe("isSemver", () => {
  it("accepts numeric triples with an optional leading v", () => {
    expect(isSemver("0.2.0")).toBe(true)
    expect(isSemver("v1.2")).toBe(true)
    expect(isSemver("10.0.1-rc1")).toBe(true)
  })

  it("rejects anything without a numeric triple", () => {
    expect(isSemver("garbage")).toBe(false)
    expect(isSemver("")).toBe(false)
    expect(isSemver("  ")).toBe(false)
  })
})

describe("compareSemver", () => {
  it("orders major/minor/patch numerically, not lexically", () => {
    expect(compareSemver("0.9.0", "0.10.0")).toBeLessThan(0)
    expect(compareSemver("0.10.0", "0.9.0")).toBeGreaterThan(0)
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0)
  })

  it("tolerates a leading v and missing parts", () => {
    expect(compareSemver("v1.2", "1.2.0")).toBe(0)
    expect(compareSemver("1.2", "1.2.1")).toBeLessThan(0)
  })

  it("treats unparseable input as equal (never blocks the UI)", () => {
    expect(compareSemver("garbage", "also-garbage")).toBe(0)
    expect(compareSemver("", "")).toBe(0)
  })
})

describe("isNewerVersion", () => {
  it("is true only when latest is strictly newer", () => {
    expect(isNewerVersion("0.1.0", "0.2.0")).toBe(true)
    expect(isNewerVersion("0.2.0", "0.2.0")).toBe(false)
    expect(isNewerVersion("0.3.0", "0.2.0")).toBe(false)
  })
})

describe("normalizeVersionManifest", () => {
  it("accepts a full version.json manifest", () => {
    expect(
      normalizeVersionManifest({
        version: "0.2.0",
        tag: "v0.2.0",
        publishedAt: "2026-10-29T00:00:00.000Z",
        notes: "Bug fixes",
      }),
    ).toEqual({
      version: "0.2.0",
      tag: "v0.2.0",
      publishedAt: "2026-10-29T00:00:00.000Z",
      notes: "Bug fixes",
    })
  })

  it("derives the tag and drops invalid extras instead of rejecting", () => {
    expect(normalizeVersionManifest({ version: "v0.2.0" })).toEqual({
      version: "0.2.0",
      tag: "v0.2.0",
      publishedAt: null,
      notes: null,
    })
    expect(normalizeVersionManifest({ version: "0.2.0", publishedAt: "not-a-date", notes: 42 })).toEqual({
      version: "0.2.0",
      tag: "v0.2.0",
      publishedAt: null,
      notes: null,
    })
  })

  it("returns null for anything without a usable version", () => {
    expect(normalizeVersionManifest(null)).toBeNull()
    expect(normalizeVersionManifest({})).toBeNull()
    expect(normalizeVersionManifest({ version: "" })).toBeNull()
    expect(normalizeVersionManifest("0.2.0")).toBeNull()
  })
})

describe("normalizeUpdateCheck", () => {
  it("keeps a valid latest release and nulls anything else (never an error state)", () => {
    expect(normalizeUpdateCheck({ latest: null })).toEqual({ latest: null })
    expect(normalizeUpdateCheck({ latest: { version: "0.2.0" } })).toEqual({
      latest: { version: "0.2.0", tag: "v0.2.0", publishedAt: null, notes: null },
    })
    expect(normalizeUpdateCheck({})).toEqual({ latest: null })
    expect(normalizeUpdateCheck(null)).toEqual({ latest: null })
    expect(normalizeUpdateCheck({ latest: { version: "" } })).toEqual({ latest: null })
  })
})

describe("androidVersionCode", () => {
  it("derives a monotonic code from semver (major*10000+minor*100+patch)", () => {
    expect(androidVersionCode("0.1.0")).toBe(100)
    expect(androidVersionCode("v0.2.3")).toBe(203)
    expect(androidVersionCode("1.0.0")).toBe(10000)
  })

  it("never decreases across the known history (0.1.0 baseline)", () => {
    expect(androidVersionCode("0.1.0")).toBeGreaterThanOrEqual(100)
  })
})
