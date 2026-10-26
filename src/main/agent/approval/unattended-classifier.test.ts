import { describe, expect, it } from "vitest"
import type { ToolAction } from "./types"
import { unattendedSurfaceDecision } from "./unattended-classifier"

const guard = {
  allowedOrigins: ["http://localhost:5173"],
  allowEvaluate: false,
  allowConsequential: false,
}
const browser = (tool: string, detail: Record<string, unknown>): ToolAction => ({
  tool,
  kind: "browser",
  summary: tool,
  identity: tool,
  detail,
})
const level = (action: ToolAction, g = guard) =>
  unattendedSurfaceDecision(action, g)?.level ?? null

describe("unattended surface guard", () => {
  it("blocks navigation and interaction off the allowlist, including local hosts", () => {
    expect(level(browser("browser_navigate", { url: "http://localhost:5173/app" }))).toBeNull()
    expect(level(browser("browser_navigate", { url: "http://localhost:3000/" }))).toBe("hard_block")
    expect(level(browser("browser_navigate", { url: "https://example.com" }))).toBe("hard_block")
    expect(level(browser("browser_navigate", { url: "not a url" }))).toBe("hard_block")
    expect(
      level(browser("browser_hover", { url: "https://evil.test/", interactionKind: "reversible_interaction" }))
    ).toBe("hard_block")
  })

  it("blocks consequential browser and Electron actions unless the step opts in", () => {
    const commit = browser("browser_click", {
      url: "http://localhost:5173/items",
      interactionKind: "consequential_commit",
    })
    const app: ToolAction = {
      tool: "electron_run",
      kind: "electron",
      summary: "run",
      identity: "run",
      detail: { interactionKind: "consequential_commit" },
    }
    expect(level(commit)).toBe("hard_block")
    expect(level(app)).toBe("hard_block")
    expect(level(commit, { ...guard, allowConsequential: true })).toBeNull()
    expect(level(app, { ...guard, allowConsequential: true })).toBeNull()
    expect(
      level(browser("browser_click", { url: "http://localhost:5173/", interactionKind: "reversible_interaction" }))
    ).toBeNull()
  })

  it("gates browser_evaluate on its own toggle and ignores other kinds", () => {
    const evaluate = browser("browser_evaluate", {
      url: "http://localhost:5173/",
      interactionKind: "consequential_commit",
    })
    expect(level(evaluate)).toBe("hard_block")
    expect(level(evaluate, { ...guard, allowEvaluate: true })).toBeNull()
    expect(
      level({ tool: "run_shell_tool", kind: "shell", summary: "ls", identity: "ls" })
    ).toBeNull()
  })
})
