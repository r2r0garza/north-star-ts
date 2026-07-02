import { describe, it, expect } from "vitest"
import { typeScriptExtractor } from "./typescript-extractor"
import { fallbackExtractor } from "./fallback-extractor"
import { pickExtractor } from "./index"

describe("typeScriptExtractor", () => {
  const extract = (content: string, ext = ".ts") =>
    typeScriptExtractor.extract({ relPath: `f${ext}`, ext, content })

  it("supports TS/JS extensions, not others", () => {
    expect(typeScriptExtractor.supports({ relPath: "a.ts", ext: ".ts" })).toBe(
      true
    )
    expect(
      typeScriptExtractor.supports({ relPath: "a.tsx", ext: ".tsx" })
    ).toBe(true)
    expect(typeScriptExtractor.supports({ relPath: "a.js", ext: ".js" })).toBe(
      true
    )
    expect(typeScriptExtractor.supports({ relPath: "a.md", ext: ".md" })).toBe(
      false
    )
  })

  it("extracts functions, classes, interfaces, types, enums, consts", () => {
    const doc = extract(`
      export function foo() {}
      class Bar {}
      export interface Baz {}
      type Qux = string
      enum Color { Red }
      export const answer = 42
    `)
    const byKind = (k: string) =>
      doc.symbols.filter((s) => s.kind === k).map((s) => s.name)
    expect(byKind("function")).toEqual(["foo"])
    expect(byKind("class")).toEqual(["Bar"])
    expect(byKind("interface")).toEqual(["Baz"])
    expect(byKind("type")).toEqual(["Qux"])
    expect(byKind("enum")).toEqual(["Color"])
    expect(byKind("const")).toEqual(["answer"])
  })

  it("marks exported declarations", () => {
    const doc = extract(`export function pub() {}\nfunction priv() {}`)
    const pub = doc.symbols.find((s) => s.name === "pub")
    const priv = doc.symbols.find((s) => s.name === "priv")
    expect(pub?.detail?.exported).toBe(true)
    expect(priv?.detail?.exported).toBe(false)
  })

  it("records line numbers (1-based)", () => {
    const doc = extract(`\n\nexport function onLineThree() {}`)
    expect(doc.symbols.find((s) => s.name === "onLineThree")?.line).toBe(3)
  })

  it("extracts imports with their source module", () => {
    const doc = extract(`
      import { readFile, writeFile } from "fs/promises"
      import ts from "typescript"
      import * as path from "path"
      import "./side-effect"
    `)
    const imports = doc.symbols.filter((s) => s.kind === "import")
    const byName = new Map(imports.map((s) => [s.name, s.detail?.module]))
    expect(byName.get("readFile")).toBe("fs/promises")
    expect(byName.get("writeFile")).toBe("fs/promises")
    expect(byName.get("ts")).toBe("typescript")
    expect(byName.get("path")).toBe("path")
    // Bare side-effect import is recorded under the module name.
    expect(byName.get("./side-effect")).toBe("./side-effect")
  })

  it("does not throw on malformed source", () => {
    expect(() => extract("export function (((")).not.toThrow()
  })
})

describe("fallbackExtractor", () => {
  it("supports everything (catch-all)", () => {
    expect(fallbackExtractor.supports({ relPath: "x.bin", ext: ".bin" })).toBe(
      true
    )
  })

  it("extracts markdown headings as symbols", () => {
    const doc = fallbackExtractor.extract({
      relPath: "README.md",
      ext: ".md",
      content: "# Title\n\nintro\n\n## Section\n\n### Sub",
    })
    const headings = doc.symbols.filter((s) => s.kind === "heading")
    expect(headings.map((h) => h.name)).toEqual(["Title", "Section", "Sub"])
    expect(headings[0].detail?.level).toBe(1)
    expect(headings[1].detail?.level).toBe(2)
  })

  it("emits chunks for plain text, no symbols", () => {
    const doc = fallbackExtractor.extract({
      relPath: "notes.txt",
      ext: ".txt",
      content: "line\n".repeat(100),
    })
    expect(doc.symbols).toHaveLength(0)
    expect(doc.chunks?.length ?? 0).toBeGreaterThan(1)
  })
})

describe("pickExtractor", () => {
  it("routes TS to the TS extractor and everything else to fallback", () => {
    expect(pickExtractor({ relPath: "a.ts", ext: ".ts" })).toBe(
      typeScriptExtractor
    )
    expect(pickExtractor({ relPath: "a.md", ext: ".md" })).toBe(
      fallbackExtractor
    )
    expect(pickExtractor({ relPath: "a.rs", ext: ".rs" })).toBe(
      fallbackExtractor
    )
  })
})
