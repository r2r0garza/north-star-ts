import { describe, expect, it } from "vitest"
import { checkGeneratedCommand, checkSetupCommand } from "./policy"
import { RegexCommandClassifier } from "../../agent/approval/regex-classifier"
import { shellActionForCommand } from "../../agent/approval/shell-analyzer"

describe("Windows shell policy remains fail-closed", () => {
  it("requires approval even for a benign Windows command", () => {
    const decision = new RegexCommandClassifier().classify(
      shellActionForCommand("echo hello", { platform: "win32" })
    )
    expect(decision?.level).toBe("require_approval")
    expect(decision?.reason).toContain("Windows shell syntax")
  })

  it.skipIf(process.platform !== "win32")("does not auto-admit setup or regeneration commands", () => {
    for (const check of [checkSetupCommand, checkGeneratedCommand]) {
      expect(check("npm install", process.cwd())).toMatchObject({
        ok: false,
        reason: expect.stringContaining("Windows shell syntax"),
      })
    }
  })
})
