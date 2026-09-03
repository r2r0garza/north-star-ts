import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { createReadSkillTool } from "./tool"
import type { SkillMetadata } from "./types"
import type { ToolContext } from "../tools/types"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "read-skill-tool-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("read_skill", () => {
  it("registers the selected skill root and returns a bounded resource manifest", async () => {
    const skillDir = join(root, "dashboard")
    await mkdir(join(skillDir, "references"), { recursive: true })
    await writeFile(join(skillDir, "references", "template.html"), "<main />")
    const skill = metadata("dashboard", skillDir)
    const ctx: ToolContext = { workspace: "/workspace" }

    const result = await createReadSkillTool([skill]).execute(
      { name: "dashboard" },
      ctx
    )

    expect(ctx.skillResourceRoots).toEqual({ dashboard: skillDir })
    expect(result).toContain(
      "[context provenance: trust=approved_instruction channel=skill source=\"dashboard\" persisted=true]"
    )
    expect(result).toContain("INSTRUCTION: # Test")
    expect(result).toContain("Skill resource root: skill://dashboard/")
    expect(result).toContain("references/")
    expect(result).toContain("references/template.html")
  })
})

function metadata(name: string, dir: string): SkillMetadata {
  return {
    name,
    description: "Test skill.",
    path: join(dir, "SKILL.md"),
    body: "# Test\n\nUse references/template.html.",
    source: root,
    metadata: {},
    allowedTools: [],
  }
}
