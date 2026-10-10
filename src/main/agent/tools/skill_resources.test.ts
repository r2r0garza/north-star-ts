import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import {
  activeSkillResourceRootPaths,
  resolveSkillResourcesInCommand,
} from "./skill_resources"
import type { ToolContext } from "./types"

let skillRoot: string
let realRoot: string
let ctx: ToolContext

beforeEach(async () => {
  skillRoot = await mkdtemp(join(tmpdir(), "skill-cmd-"))
  realRoot = await realpath(skillRoot)
  await mkdir(join(skillRoot, "scripts"))
  await writeFile(join(skillRoot, "scripts", "tool.py"), "print('hi')\n")
  ctx = { workspace: "/workspace", skillResourceRoots: { demo: skillRoot } }
})

afterEach(async () => {
  await rm(skillRoot, { recursive: true, force: true })
})

// Runs the rewritten command through a real POSIX shell and returns what the
// shell actually passed as arguments, one per line.
function shellArgs(command: string): string[] {
  const out = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" })
  return out.split("\n").filter(Boolean)
}

describe("resolveSkillResourcesInCommand", () => {
  it("leaves commands without skill:// tokens untouched", async () => {
    const result = await resolveSkillResourcesInCommand(
      ctx,
      "echo hi",
      "darwin"
    )
    expect(result).toEqual({ command: "echo hi", resources: [] })
  })

  it("rewrites bare, assigned, and quoted tokens to the real path", async () => {
    const tool = join(realRoot, "scripts", "tool.py")
    const result = await resolveSkillResourcesInCommand(
      ctx,
      `python3 skill://demo/scripts/tool.py --x "skill://demo/scripts/tool.py"`,
      "darwin"
    )

    expect(result.command).toBe(
      `python3 '${tool}' --x "${tool.replace(/["$\\]/g, (char) => "\\" + char)}"`
    )
    expect(result.resources).toEqual([
      { uri: "skill://demo/scripts/tool.py", path: tool },
      { uri: "skill://demo/scripts/tool.py", path: tool },
    ])
  })

  it.skipIf(process.platform === "win32")(
    "quotes awkward paths correctly in every shell quoting context",
    async () => {
      // No backslash: the URI parser treats it as a separator, as read_file does.
      const odd = `it's "odd" $HOME dir`
      await mkdir(join(skillRoot, odd))
      const expected = join(realRoot, odd)
      // encodeURIComponent leaves ' alone, and a bare ' ends the token.
      const uri = `skill://demo/${encodeURIComponent(odd).replace(/'/g, "%27")}`

      for (const template of [
        `printf '%s\\n' ${uri}`,
        `printf '%s\\n' "${uri}"`,
        `printf '%s\\n' '${uri}'`,
        `X=${uri}; printf '%s\\n' "$X"`,
      ]) {
        const { command } = await resolveSkillResourcesInCommand(
          ctx,
          template,
          "darwin"
        )
        expect(shellArgs(command), template).toEqual([expected])
      }
    }
  )

  it("uses cmd.exe double quotes on Windows and refuses % in paths", async () => {
    const tool = join(realRoot, "scripts", "tool.py")
    const result = await resolveSkillResourcesInCommand(
      ctx,
      `python3 skill://demo/scripts/tool.py`,
      "win32"
    )
    expect(result.command).toBe(`python3 "${tool}"`)

    await mkdir(join(skillRoot, "100%"))
    await expect(
      resolveSkillResourcesInCommand(ctx, "dir skill://demo/100%25", "win32")
    ).rejects.toThrow("cmd.exe")
  })

  it("ignores lookalike schemes such as myskill://", async () => {
    const command = "echo myskill://demo/scripts/tool.py"
    const result = await resolveSkillResourcesInCommand(ctx, command, "darwin")
    expect(result).toEqual({ command, resources: [] })
  })

  it("keeps read_file's activation, traversal, case, and symlink checks", async () => {
    const outside = await mkdtemp(join(tmpdir(), "skill-cmd-outside-"))
    try {
      await writeFile(join(outside, "evil.sh"), "echo pwned\n")
      await symlink(
        outside,
        join(skillRoot, "escape"),
        process.platform === "win32" ? "junction" : "dir"
      )

      for (const [command, message] of [
        ["sh skill://other/run.sh", "Call read_skill"],
        ["sh skill://demo/../x.sh", "Parent traversal"],
        ["sh skill://demo/%2Fetc%2Fpasswd", "Absolute"],
        ["sh skill://demo/escape/evil.sh", "symlink"],
        ["python3 skill://demo/Scripts/tool.py", "ENOENT"],
      ]) {
        await expect(
          resolveSkillResourcesInCommand(ctx, command, "darwin"),
          command
        ).rejects.toThrow(message)
      }
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe("activeSkillResourceRootPaths", () => {
  it("returns registered and real spellings of each activated root", async () => {
    const roots = await activeSkillResourceRootPaths(ctx)
    expect(roots).toContain(skillRoot)
    expect(roots).toContain(realRoot)
    expect(await activeSkillResourceRootPaths({ workspace: "/w" })).toEqual([])
  })
})
