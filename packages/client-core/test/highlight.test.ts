import { describe, expect, it } from "vitest"
import { detectLanguage, highlightCode, highlightLine, type HighlightLanguage } from "../src/highlight"

describe("detectLanguage (#123)", () => {
  it("maps file paths by extension", () => {
    expect(detectLanguage("src/app.ts")).toBe("ts")
    expect(detectLanguage("src/App.tsx")).toBe("tsx")
    expect(detectLanguage("script.py")).toBe("py")
    expect(detectLanguage("run.sh")).toBe("sh")
    expect(detectLanguage("data.json")).toBe("json")
  })

  it("normalizes fence info aliases", () => {
    expect(detectLanguage("typescript")).toBe("ts")
    expect(detectLanguage("javascript")).toBe("js")
    expect(detectLanguage("python")).toBe("py")
    expect(detectLanguage("bash")).toBe("sh")
  })

  it("returns null for unknown or missing languages", () => {
    expect(detectLanguage(undefined)).toBeNull()
    expect(detectLanguage("")).toBeNull()
    expect(detectLanguage("notes.txt")).toBeNull()
    expect(detectLanguage("data.yaml")).toBeNull()
  })
})

describe("highlightLine (#123)", () => {
  it("marks keywords, strings, numbers and comments", () => {
    const kinds = highlightLine("export const app = 1 // done", "ts").map((token) => token.kind)
    expect(kinds).toContain("keyword")
    expect(kinds).toContain("number")
    expect(kinds).toContain("comment")
    const text = highlightLine("export const app = 1 // done", "ts")
      .map((token) => token.text)
      .join("")
    expect(text).toBe("export const app = 1 // done")
  })

  it("marks function calls and capitalized types", () => {
    const tokens = highlightLine("const r = fetch(url)", "ts")
    expect(tokens.find((token) => token.text === "fetch")?.kind).toBe("function")
    const types = highlightLine("const p: Promise<number> = x", "ts")
    expect(types.find((token) => token.text === "Promise")?.kind).toBe("type")
  })

  it("handles python and shell comments", () => {
    expect(highlightLine("def f(): # hi", "py").some((token) => token.kind === "comment")).toBe(true)
    expect(highlightLine("echo hi # yo", "sh").some((token) => token.kind === "comment")).toBe(true)
  })

  it("renders unknown languages as plain text", () => {
    expect(highlightLine("hello world", null)).toEqual([{ text: "hello world", kind: "plain" }])
    // An untyped caller may pass a language the scanner has no grammar for.
    expect(highlightLine("a: 1", "yaml" as unknown as HighlightLanguage)).toEqual([
      { text: "a: 1", kind: "plain" },
    ])
  })
})

describe("highlightCode (#123)", () => {
  it("keeps every line and never drops text", () => {
    const text = "const a = 1\nconst b = 'x'\n// end"
    const lines = highlightCode(text, "ts")
    expect(lines).toHaveLength(3)
    expect(lines.map((line) => line.map((token) => token.text).join("")).join("\n")).toBe(text)
  })

  it("caps runaway input instead of tokenizing forever", () => {
    const big = Array.from({ length: 500 }, (_, index) => `const a${index} = ${index}`).join("\n")
    const lines = highlightCode(big, "ts", 50)
    expect(lines).toHaveLength(50)
    expect(lines[0]![0]!.kind).toBe("keyword")
  })
})
