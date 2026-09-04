import { describe, expect, it } from "vitest"
import { isManagedMemoryPath } from "./mutation"

describe("isManagedMemoryPath", () => {
  it("blocks every file under a managed memory skill", () => {
    const blocked = [
      "/Users/a/proj/.cowork/skills/memory-recent/staging.md",
      "/Users/a/proj/.cowork/skills/memory-recent/staging.processing.md",
      "/Users/a/proj/.cowork/skills/memory-recent/reference/2026-09-04.md",
      "/Users/a/proj/.cowork/skills/memory-knowledge/SKILL.md",
      "/Users/a/.cowork/skills/memory-identity/SKILL.md",
      // Holds for a renamed install, not just the default slug.
      "/Users/a/proj/.north-star/skills/memory-lessons/SKILL.md",
    ]
    for (const file of blocked) {
      expect(isManagedMemoryPath(file), file).toBe(true)
    }
  })

  it("leaves ordinary workspace and skill files writable", () => {
    const allowed = [
      "/Users/a/proj/src/main/agent/memory/service.ts",
      "/Users/a/proj/.cowork/skills/git-commit/SKILL.md",
      "/Users/a/proj/.cowork/agents/test.agent.md",
      "/Users/a/proj/docs/memory-notes.md",
      // "memory-" only counts directly under a dot-dir's skills/.
      "/Users/a/proj/skills/memory-recent/staging.md",
      "/Users/a/proj/.cowork/memory-recent/staging.md",
    ]
    for (const file of allowed) {
      expect(isManagedMemoryPath(file), file).toBe(false)
    }
  })
})
