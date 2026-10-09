import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import {
  privateDirectories,
  resolveExecutable,
  verifyCliCompatibility,
} from "./setup"
import { buildHostCliEnv } from "../../env/host-cli-env"

vi.mock("./auth-policy", () => ({ verifyPersonalSubscription: vi.fn() }))
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ns-linux-setup-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
describe.skipIf(process.platform !== "linux")(
  "native Linux private state and executable discovery",
  () => {
    it("protects directories and request files, confines paths and cleans independently", async () => {
      const first = await privateDirectories(root)
      const second = await privateDirectories(root)
      expect(first.cwd).toBe(second.cwd)
      expect(await readdir(first.cwd)).toEqual([])
      for (const path of [
        join(root, "claude-subscription-transport"),
        first.cwd,
        first.directory,
      ]) {
        const stat = await lstat(path)
        expect(stat.mode & 0o777).toBe(0o700)
        expect(stat.uid).toBe(process.getuid!())
      }
      const file = await first.file("settings.json", "{}")
      expect((await lstat(file)).mode & 0o777).toBe(0o600)
      for (const name of ["../escape", "/escape", "", "a:b"])
        await expect(first.file(name, "fixture")).rejects.toThrow(
          "Invalid private file"
        )
      await expect(
        first.file("settings.json", "overwrite")
      ).rejects.toMatchObject({ code: "EEXIST" })
      await first.close()
      expect(await readdir(second.directory)).toEqual([])
      await second.close()
      expect(
        await readdir(join(root, "claude-subscription-transport"))
      ).toEqual(["cwd"])
    })
    it.each(["root", "cwd"])(
      "rejects public permissions on %s",
      async (target) => {
        const state = await privateDirectories(root)
        await state.close()
        await chmod(
          target === "root"
            ? join(root, "claude-subscription-transport")
            : state.cwd,
          0o755
        )
        await expect(privateDirectories(root)).rejects.toMatchObject({
          code: "claude_subscription_private_state",
        })
      }
    )
    it("rejects a symlink CWD and nonempty stable CWD", async () => {
      const state = await privateDirectories(root)
      await state.close()
      await writeFile(join(state.cwd, "unexpected"), "fixture")
      await expect(privateDirectories(root)).rejects.toMatchObject({
        code: "claude_subscription_private_state",
      })
      await rm(state.cwd, { recursive: true })
      const outside = join(root, "outside")
      await mkdir(outside)
      await symlink(outside, state.cwd)
      await expect(privateDirectories(root)).rejects.toMatchObject({
        code: "claude_subscription_private_state",
      })
    })
    it("resolves executable symlinks in spaces/non-ASCII paths without accepting relative PATH", async () => {
      const bin = join(root, "bin space-é")
      await mkdir(bin)
      await symlink(process.execPath, join(bin, "claude"))
      expect(await resolveExecutable({ PATH: bin })).toBe(
        await realpath(process.execPath)
      )
      await expect(
        resolveExecutable({ PATH: ".:relative" })
      ).rejects.toMatchObject({ code: "claude_subscription_cli_missing" })
      await rm(join(bin, "claude"))
      await writeFile(join(bin, "claude"), "fixture", { mode: 0o600 })
      await expect(resolveExecutable({ PATH: bin })).rejects.toMatchObject({
        code: "claude_subscription_cli_missing",
      })
    })
    it("discovers the installed native CLI from GUI-style minimal PATH and HOME", async () => {
      const env = buildHostCliEnv({
        HOME: process.env.HOME,
        PATH: "/usr/bin:/bin",
      })
      expect(await resolveExecutable(env)).toBe(
        await resolveExecutable(process.env)
      )
    })
    it.each(["failed", "stalled"])(
      "sanitizes %s native version probes",
      async (mode) => {
        const file = join(root, "probe space-é")
        await writeFile(
          file,
          mode === "failed"
            ? "#!/bin/sh\necho SECRET >&2\nexit 1\n"
            : "#!/bin/sh\nexec /bin/sleep 30\n",
          { mode: 0o700 }
        )
        const state = await privateDirectories(root)
        try {
          await expect(
            verifyCliCompatibility(
              file,
              state.cwd,
              { HOME: root },
              new AbortController().signal
            )
          ).rejects.toMatchObject({ code: "claude_subscription_cli_probe" })
        } finally {
          await state.close()
        }
      },
      10000
    )
  }
)
