import { describe, expect, it } from "vitest"
import { mkdtemp, mkdir, rm } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { privateDirectories, resolveExecutable } from "./setup"
import { windowsPrivatePath, windowsProbe } from "./windows-state"

describe.skipIf(process.platform !== "win32")(
  "native Windows private state",
  () => {
    it("inherits private ACLs on every artifact and rejects path escapes and public existing state", async () => {
      const root = await mkdtemp(join(tmpdir(), "ns Windows é-"))
      try {
        const files = await privateDirectories(root)
        await windowsPrivatePath(files.cwd)
        await windowsPrivatePath(files.directory)
        const path = await files.file("system é.txt", "synthetic")
        await windowsPrivatePath(path)
        for (const name of [
          "../escape",
          "..\\escape",
          "C:\\escape",
          "system.txt:stream",
          "",
        ])
          await expect(files.file(name, "synthetic")).rejects.toThrow(
            "Invalid private file"
          )
        await files.close()
        const publicParent = join(root, "public")
        await mkdir(join(publicParent, "claude-subscription-transport"), {
          recursive: true,
        })
        await windowsProbe(
          `$ErrorActionPreference = 'Stop'; $p = $env:NS_FIXTURE_PATH; $acl = Get-Acl -LiteralPath $p; $sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'Read', 'Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl`,
          {
            ...process.env,
            NS_FIXTURE_PATH: join(
              publicParent,
              "claude-subscription-transport"
            ),
          },
          new AbortController().signal,
          "fixture_acl"
        )
        await expect(privateDirectories(publicParent)).rejects.toMatchObject({
          code: "claude_subscription_private_state",
        })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }, 30000)
    it("finds the installed native executable with Windows Path casing and rejects relative search directories", async () => {
      const executable = await resolveExecutable({ Path: process.env.PATH })
      expect(executable.toLowerCase()).toMatch(/claude\.exe$/)
      await expect(
        resolveExecutable({ Path: ".;relative" })
      ).rejects.toMatchObject({ code: "claude_subscription_cli_missing" })
    })
  }
)
