import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  documentSymbolsTool,
  findReferencesTool,
  goToDefinitionTool,
  hoverTypeTool,
  workspaceSymbolsTool,
} from "./code_navigation_tools"
import { workspaceDiagnosticsTool } from "./test_diagnostics_tools"
import type { ToolContext } from "./types"

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "north-star-nav-"))
  writeFileSync(
    join(workspace, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
      },
      include: ["src/**/*.ts"],
    }),
    "utf8"
  )
  mkdirSync(join(workspace, "src"))
  writeFileSync(
    join(workspace, "src", "math.ts"),
    [
      "export interface CalcInput {",
      "  value: number",
      "}",
      "",
      "export function double(input: CalcInput): number {",
      "  return input.value * 2",
      "}",
      "",
      "export const aliasDouble = double",
      "",
    ].join("\n"),
    "utf8"
  )
  writeFileSync(
    join(workspace, "src", "app.ts"),
    [
      "import { double, aliasDouble } from './math'",
      "",
      "const result = double({ value: 21 })",
      "const again = aliasDouble({ value: result })",
      "const broken: string = result",
      "",
    ].join("\n"),
    "utf8"
  )
  writeFileSync(join(workspace, "README.md"), "# Unsupported\n", "utf8")
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

function ctx(): ToolContext {
  return { workspace, conversationId: "c1" }
}

function parsed(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>
}

describe("semantic code navigation tools", () => {
  it("lists document symbols and workspace symbols with semantic precision", async () => {
    const document = parsed(
      await documentSymbolsTool.execute({ path: "src/math.ts" }, ctx())
    )
    const workspaceHits = parsed(
      await workspaceSymbolsTool.execute({ query: "double" }, ctx())
    )

    expect(document.status).toBe("ok")
    expect(document.precision).toBe("semantic")
    expect(document.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "CalcInput", path: "src/math.ts" }),
        expect.objectContaining({ name: "double", path: "src/math.ts" }),
      ])
    )
    expect(workspaceHits.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "double", path: "src/math.ts" }),
        expect.objectContaining({
          name: "aliasDouble",
          path: "src/math.ts",
        }),
      ])
    )
  })

  it("resolves definitions, references, and hover type information", async () => {
    const definition = parsed(
      await goToDefinitionTool.execute(
        { path: "src/app.ts", line: 3, column: 16 },
        ctx()
      )
    )
    const references = parsed(
      await findReferencesTool.execute(
        {
          path: "src/app.ts",
          line: 3,
          column: 16,
          include_declaration: false,
        },
        ctx()
      )
    )
    const hover = parsed(
      await hoverTypeTool.execute(
        { path: "src/app.ts", line: 3, column: 16 },
        ctx()
      )
    )

    expect(definition.definitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/math.ts",
          line: 5,
          name: "double",
        }),
      ])
    )
    expect(references.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/app.ts", line: 3 }),
      ])
    )
    expect(hover.display).toContain("double")
    expect(hover.display).toContain("CalcInput")
  })

  it("returns provider_unavailable for unsupported files", async () => {
    const result = parsed(
      await documentSymbolsTool.execute({ path: "README.md" }, ctx())
    )

    expect(result.status).toBe("provider_unavailable")
    expect(result.provider).toBe("typescript-language-service")
  })

  it("exposes TypeScript diagnostics through workspace_diagnostics semantic target", async () => {
    const result = parsed(
      await workspaceDiagnosticsTool.execute({ target: "semantic" }, ctx())
    )

    expect(result.status).toBe("ok")
    expect(result.provider).toBe("typescript-language-service")
    expect(result.counts).toEqual(
      expect.objectContaining({ errors: expect.any(Number) })
    )
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/app.ts",
          code: "TS2322",
          source: "typescript-language-service",
        }),
      ])
    )
  })
})
