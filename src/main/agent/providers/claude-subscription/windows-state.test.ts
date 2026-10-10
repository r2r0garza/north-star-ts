import { describe, expect, it } from "vitest"
import {
  mkdtemp,
  mkdir,
  rm,
  copyFile,
  writeFile,
  realpath,
  symlink,
} from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { privateDirectories, resolveExecutable } from "./setup"
import {
  withWindowsProbeWorker,
  closeWindowsProbeWorker,
  windowsPrivatePath,
  windowsPrivatePaths,
  windowsProbe,
} from "./windows-state"

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
        const batch = await files.files([
          { name: "batch é.txt", value: "first" },
          { name: "batch ' second.txt", value: "second" },
        ])
        await windowsPrivatePaths(batch.map((path) => ({ path })))
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
        await expect(
          windowsPrivatePaths([
            { path },
            { path: join(publicParent, "claude-subscription-transport") },
          ])
        ).rejects.toMatchObject({ code: "claude_subscription_private_state" })
        await expect(privateDirectories(publicParent)).rejects.toMatchObject({
          code: "claude_subscription_private_state",
        })
        await files.close()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }, 30000)
    it("rejects missing paths, junctions, deny ACEs and invalid transport paths", async () => {
      const root = await mkdtemp(join(tmpdir(), "ns reject é '-"))
      const signal = new AbortController().signal
      try {
        await withWindowsProbeWorker(signal, async () => {
          const files = await privateDirectories(root, signal)
          try {
            const junction = join(files.directory, "junction")
            await symlink(files.cwd, junction, "junction")
            await expect(windowsPrivatePath(junction)).rejects.toMatchObject({
              code: "claude_subscription_private_state",
            })
          } finally {
            await files.close()
          }
        })
        await expect(
          windowsPrivatePath(join(root, "missing"))
        ).rejects.toMatchObject({
          code: "claude_subscription_private_state",
        })
        await withWindowsProbeWorker(signal, async () => {
          const files = await privateDirectories(root, signal)
          try {
            const path = await files.file("deny.txt", "synthetic")
            await windowsProbe(
              "$p = $env:NS_PRIVATE_PATHS; $acl = [System.IO.File]::GetAccessControl($p); $sid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'); $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'Write', 'Deny'); $acl.AddAccessRule($rule); [System.IO.File]::SetAccessControl($p, $acl)",
              { ...process.env, NS_PRIVATE_PATHS: path },
              signal,
              "fixture"
            )
            await expect(windowsPrivatePath(path)).rejects.toMatchObject({
              code: "claude_subscription_private_state",
            })
          } finally {
            await files.close()
          }
        })
        for (const path of [
          "",
          "C:\\bad\npath",
          "C:\\bad\rpath",
          "C:\\bad\0path",
        ])
          await expect(windowsPrivatePath(path)).rejects.toMatchObject({
            code: "claude_subscription_private_state",
          })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }, 30000)
    it("measures equivalent separate and batched artifact ACL verification", async () => {
      const root = await mkdtemp(join(tmpdir(), "ns-acl-timing-"))
      try {
        const files = await privateDirectories(root)
        const paths = await files.files(
          Array.from({ length: 4 }, (_, i) => ({
            name: `artifact-${i}.txt`,
            value: "synthetic",
          }))
        )
        const started = performance.now()
        for (const path of paths) await windowsPrivatePath(path)
        const separateMs = Math.round(performance.now() - started)
        const batchStarted = performance.now()
        await windowsPrivatePaths(paths.map((path) => ({ path })))
        console.info("Windows artifact ACL timing", {
          separateMs,
          batchedMs: Math.round(performance.now() - batchStarted),
        })
        await files.close()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }, 30000)
    it("reuses one request worker with Unicode paths and rechecks changed ACLs", async () => {
      const root = await mkdtemp(join(tmpdir(), "ns-worker é-"))
      const started = performance.now()
      try {
        await withWindowsProbeWorker(new AbortController().signal, async () => {
          const pid = await windowsProbe(
            "Write-Output $PID",
            process.env,
            new AbortController().signal,
            "fixture"
          )
          const files = await privateDirectories(root)
          const path = await files.file("quoted ' é.txt", "synthetic")
          expect(
            await windowsProbe(
              "Write-Output $PID",
              process.env,
              new AbortController().signal,
              "fixture"
            )
          ).toBe(pid)
          await windowsPrivatePath(path)
          await windowsProbe(
            "Write-Output 'absent'",
            process.env,
            new AbortController().signal,
            "fixture"
          )
          await windowsProbe(
            "$p = $env:NS_PRIVATE_PATHS; $acl = Get-Acl -LiteralPath $p; $sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'Read', 'Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl",
            { ...process.env, NS_PRIVATE_PATHS: path },
            new AbortController().signal,
            "fixture"
          )
          await expect(windowsPrivatePath(path)).rejects.toMatchObject({
            code: "claude_subscription_private_state",
          })
          await files.close()
        })
        console.info(
          "Windows request worker checks ms",
          Math.round(performance.now() - started)
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }, 15000)
    it("cancels a pending worker and isolates concurrent owners", async () => {
      const controller = new AbortController()
      const pending = withWindowsProbeWorker(controller.signal, async () => {
        const probe = windowsProbe(
          "Start-Sleep -Seconds 30",
          process.env,
          controller.signal,
          "fixture"
        )
        setTimeout(() => controller.abort(), 100)
        await expect(probe).rejects.toMatchObject({ name: "AbortError" })
      })
      const other = withWindowsProbeWorker(
        new AbortController().signal,
        async () => {
          expect(
            await windowsProbe(
              "Write-Output 'independent'",
              process.env,
              new AbortController().signal,
              "fixture"
            )
          ).toBe("independent")
          await closeWindowsProbeWorker()
        }
      )
      await Promise.all([pending, other])
    }, 15000)
    it("fails closed on an unexpected worker response without leaking output", async () => {
      await expect(
        withWindowsProbeWorker(new AbortController().signal, () =>
          windowsProbe(
            "[Console]::WriteLine('SECRET'); Write-Output 'private'",
            process.env,
            new AbortController().signal,
            "fixture_protocol"
          )
        )
      ).rejects.toMatchObject({ code: "fixture_protocol" })
    }, 15000)
    it("bounds a stalled worker and rejects subsequent probes", async () => {
      await withWindowsProbeWorker(new AbortController().signal, async () => {
        await expect(
          windowsProbe(
            "Start-Sleep -Seconds 30",
            process.env,
            new AbortController().signal,
            "fixture_timeout"
          )
        ).rejects.toMatchObject({ code: "fixture_timeout" })
        await expect(windowsPrivatePath("C:\\unused")).rejects.toThrow(
          "unavailable"
        )
      })
    }, 15000)
    it("resolves native executables in spaces/non-ASCII paths and rejects npm shims", async () => {
      const root = await mkdtemp(join(tmpdir(), "ns executable é-"))
      try {
        await copyFile(process.execPath, join(root, "claude.exe"))
        expect(await resolveExecutable({ Path: root })).toBe(
          await realpath(join(root, "claude.exe"))
        )
        await rm(join(root, "claude.exe"))
        await writeFile(join(root, "claude.cmd"), "@echo fixture")
        await expect(resolveExecutable({ Path: root })).rejects.toMatchObject({
          code: "claude_subscription_cli_shim",
        })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
    it("finds the installed native executable with Windows Path casing and rejects relative search directories", async () => {
      const executable = await resolveExecutable({ Path: process.env.PATH })
      expect(executable.toLowerCase()).toMatch(/claude\.exe$/)
      await expect(
        resolveExecutable({ Path: ".;relative" })
      ).rejects.toMatchObject({ code: "claude_subscription_cli_missing" })
    })
  }
)
