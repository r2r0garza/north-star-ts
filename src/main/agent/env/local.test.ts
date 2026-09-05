import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execSync } from "child_process"
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  appendFile,
  mkdir,
  chmod,
  symlink,
  stat,
  readdir,
  open as fsOpen,
} from "fs/promises"
import type { Dir } from "fs"
import type { FileHandle } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import {
  LocalEnvironment,
  materializePythonHeredocCommand,
  normalizeHostShellCommand,
} from "./local"
import { runToolCallBatches } from "../tool-batch-scheduler"
import { TOOL_EFFECTS } from "../tools/types"
import type { CommandSessionHandle } from "./types"
import { SearchExecutionError, SearchPatternError } from "./ripgrep"
import { applyPatchTool } from "../tools/apply_patch_tool"
import {
  buildDarwinSandboxProfile,
  localProfileCapabilities,
} from "./local-profiles"

let workspace: string
let env: LocalEnvironment
let canInspectProcesses = process.platform !== "win32"
if (canInspectProcesses) {
  try {
    execSync("ps -eo pid,command", { stdio: "ignore" })
  } catch {
    canInspectProcesses = false
  }
}

const nodeCmd = (code: string) =>
  `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "env-local-"))
  env = new LocalEnvironment(workspace)
})
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe("LocalEnvironment.exec", () => {
  it("runs a command and reports exit code 0", async () => {
    const r = await env.exec("echo hello", {
      cwd: workspace,
      timeoutMs: 5000,
      maxOutputBytes: 1024 * 1024,
    })
    expect(r.stdout.toString("utf8")).toContain("hello")
    expect(r.exitCode).toBe(0)
    expect(r.timedOut).toBe(false)
  })

  it("reports a nonzero exit code", async () => {
    const r = await env.exec(nodeCmd("process.exit(3)"), {
      cwd: workspace,
      timeoutMs: 5000,
      maxOutputBytes: 1024 * 1024,
    })
    expect(r.exitCode).toBe(3)
  })

  it("times out a long-running command", async () => {
    const r = await env.exec(nodeCmd("setTimeout(() => {}, 5000)"), {
      cwd: workspace,
      timeoutMs: 100,
      maxOutputBytes: 1024 * 1024,
    })
    expect(r.timedOut).toBe(true)
  })

  it("preserves multibyte UTF-8 (decodes the Buffer once)", async () => {
    const r = await env.exec(
      nodeCmd("process.stdout.write('日本語 — café 🚀')"),
      {
        cwd: workspace,
        timeoutMs: 5000,
        maxOutputBytes: 1024 * 1024,
      }
    )
    const out = r.stdout.toString("utf8")
    expect(out).toContain("日本語 — café 🚀")
    expect(out).not.toContain("�") // no replacement chars
  })

  it("kills the command when the signal aborts (and only then)", async () => {
    const ac = new AbortController()
    const p = env.exec(nodeCmd("setTimeout(() => {}, 5000)"), {
      cwd: workspace,
      timeoutMs: 5000,
      maxOutputBytes: 1024 * 1024,
      signal: ac.signal,
    })
    setTimeout(() => ac.abort(), 50)
    const r = await p
    // Killed before the 5s timeout fired.
    expect(r.timedOut).toBe(false)
    if (process.platform !== "win32") expect(r.signal).toBe("SIGKILL")
  })

  // A pipeline forces the shell to STAY as a parent of two children (it can't exec
  // a single binary into itself), so a bare child.kill of the sh wrapper would
  // orphan the `sleep` grandchild (reparented to init). detached + process-group
  // kill must reap it. We tag the grandchild with a unique marker and assert no
  // process carrying that marker survives.
  const markerSurvives = (marker: string): boolean => {
    const out = execSync("ps -eo pid,command", { encoding: "utf8" })
    return out
      .split("\n")
      .some((line) => line.includes(marker) && !line.includes("ps -eo"))
  }

  it.skipIf(!canInspectProcesses)(
    "reaps the whole process group on abort (no orphaned grandchild)",
    async () => {
      const marker = "envlocal-abort-marker-9f3a"
      const ac = new AbortController()
      const p = env.exec(`sleep 30 | grep ${marker}`, {
        cwd: workspace,
        timeoutMs: 30_000,
        maxOutputBytes: 1024 * 1024,
        signal: ac.signal,
      })
      setTimeout(() => ac.abort(), 100)
      const r = await p
      expect(r.signal).toBe("SIGKILL")
      expect(r.timedOut).toBe(false)
      // Give the OS a beat to tear the group down before we look.
      await new Promise((res) => setTimeout(res, 200))
      if (markerSurvives(marker)) {
        execSync(`pkill -f ${marker} || true`)
        throw new Error("orphaned grandchild survived abort")
      }
    }
  )

  it.skipIf(!canInspectProcesses)(
    "reaps the whole process group on timeout (no orphaned grandchild)",
    async () => {
      const marker = "envlocal-timeout-marker-7b21"
      const r = await env.exec(`sleep 30 | grep ${marker}`, {
        cwd: workspace,
        timeoutMs: 100,
        maxOutputBytes: 1024 * 1024,
      })
      expect(r.timedOut).toBe(true)
      await new Promise((res) => setTimeout(res, 200))
      if (markerSurvives(marker)) {
        execSync(`pkill -f ${marker} || true`)
        throw new Error("orphaned grandchild survived timeout")
      }
    }
  )
})

describe("normalizeHostShellCommand", () => {
  it("uses the Python Launcher for python3 on Windows", () => {
    expect(normalizeHostShellCommand('python3 -c "print(1)"', "win32")).toBe(
      'py -3 -c "print(1)"'
    )
    expect(normalizeHostShellCommand("  python3.exe script.py", "win32")).toBe(
      "  py -3 script.py"
    )
  })

  it("does not rewrite python3 on non-Windows platforms", () => {
    expect(normalizeHostShellCommand("python3 -V", "darwin")).toBe("python3 -V")
  })
})

describe("materializePythonHeredocCommand", () => {
  it("turns a Windows python3 heredoc into a script-file command", () => {
    expect(
      materializePythonHeredocCommand(
        "python3 - <<'PY'\nprint('hello')\nPY",
        "C:\\Temp\\script.py",
        "win32"
      )
    ).toEqual({
      command: 'py -3 "C:\\Temp\\script.py"',
      script: "print('hello')",
    })
  })

  it("supports unquoted heredoc delimiters", () => {
    expect(
      materializePythonHeredocCommand(
        "python - <<PY\nprint(1)\nPY",
        "C:\\Temp\\script.py",
        "win32"
      )
    ).toEqual({
      command: 'python "C:\\Temp\\script.py"',
      script: "print(1)",
    })
  })

  it("leaves heredocs alone on non-Windows platforms", () => {
    expect(
      materializePythonHeredocCommand(
        "python3 - <<'PY'\nprint('hello')\nPY",
        "/tmp/script.py",
        "darwin"
      )
    ).toBeNull()
  })
})

describe("LocalEnvironment file ops", () => {
  async function withParentSwapEnv(
    opToSwap: string,
    run: (raceEnv: LocalEnvironment, external: string) => Promise<void>
  ) {
    const external = await mkdtemp(join(tmpdir(), "env-local-external-"))
    let swapped = false
    const raceEnv = new LocalEnvironment(workspace, "host-access", {
      beforeLocalFileSyscall: async (op) => {
        if (swapped || op !== opToSwap) return
        swapped = true
        await rm(join(workspace, "safe"), { recursive: true, force: true })
        await symlink(external, join(workspace, "safe"))
      },
    })

    try {
      await mkdir(join(workspace, "safe"), { recursive: true })
      await run(raceEnv, external)
      expect(swapped).toBe(true)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  }

  it("writes and reads a file, round-tripping bytes", async () => {
    const target = await env.resolve("note.txt")
    await env.writeFile(target, "hi there")
    const buf = await env.readFile(target)
    expect(buf.toString("utf8")).toBe("hi there")
  })

  it("allows file operations in dot-dot-prefixed directories", async () => {
    const target = await env.resolve("..cache/note.txt")
    await env.mkdirp(join(workspace, "..cache"))
    await env.writeFile(target, "cached")

    expect((await env.readFile(target)).toString("utf8")).toBe("cached")
  })

  it("mkdirp creates nested directories", async () => {
    const dir = await env.resolve("a/b/c")
    await env.mkdirp(dir)
    const info = await env.stat(dir)
    expect(info.isDirectory()).toBe(true)
  })

  it("rename moves a file", async () => {
    await writeFile(join(workspace, "from.txt"), "x")
    await env.rename(join(workspace, "from.txt"), join(workspace, "to.txt"))
    expect((await readFile(join(workspace, "to.txt"))).toString()).toBe("x")
  })

  it("renameNoReplace moves without replacing an existing destination", async () => {
    await writeFile(join(workspace, "from.txt"), "x")
    await writeFile(join(workspace, "to.txt"), "y")

    await expect(
      env.renameNoReplace(
        join(workspace, "from.txt"),
        join(workspace, "to.txt")
      )
    ).rejects.toThrow()

    await env.renameNoReplace(
      join(workspace, "from.txt"),
      join(workspace, "created.txt")
    )
    expect(await readFile(join(workspace, "created.txt"), "utf8")).toBe("x")
  })

  it("removes directories only recursively when requested", async () => {
    await mkdir(join(workspace, "empty"))
    await mkdir(join(workspace, "tree", "child"), { recursive: true })

    await env.removeDirectory(join(workspace, "empty"))
    await expect(env.removeDirectory(join(workspace, "tree"))).rejects.toThrow()
    await env.removeDirectory(join(workspace, "tree"), { recursive: true })
    await expect(env.stat(join(workspace, "tree"))).rejects.toThrow()
  })

  it("installs a file only when the destination is absent", async () => {
    await writeFile(join(workspace, "staged.txt"), "staged")
    await env.installFileNoReplace(
      join(workspace, "staged.txt"),
      join(workspace, "created.txt")
    )

    expect((await readFile(join(workspace, "created.txt"))).toString()).toBe(
      "staged"
    )
    expect((await readFile(join(workspace, "staged.txt"))).toString()).toBe(
      "staged"
    )
  })

  it("does not replace an existing destination during no-replace install", async () => {
    await writeFile(join(workspace, "staged.txt"), "staged")
    await writeFile(join(workspace, "created.txt"), "external")

    await expect(
      env.installFileNoReplace(
        join(workspace, "staged.txt"),
        join(workspace, "created.txt")
      )
    ).rejects.toThrow()

    expect((await readFile(join(workspace, "created.txt"))).toString()).toBe(
      "external"
    )
    expect((await readFile(join(workspace, "staged.txt"))).toString()).toBe(
      "staged"
    )
  })

  it("cleans a patch temp file when a local write persists and then fails", async () => {
    await writeFile(join(workspace, "a.txt"), "old\n")
    const writeThrough = env.writeFile.bind(env)
    env.writeFile = async (path, data) => {
      await writeThrough(path, data)
      if (path.includes(".north-star-")) {
        throw new Error("injected local write failure after persist")
      }
    }

    const result = await applyPatchTool.execute(
      {
        operations: [
          {
            type: "update",
            path: "a.txt",
            hunks: [{ old_string: "old", new_string: "new" }],
          },
        ],
      },
      { workspace, env }
    )

    expect(result).toContain("ERROR[commit_failed]")
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("old\n")
    expect(
      (await env.readdir(workspace)).filter((entry) =>
        entry.name.includes(".north-star-")
      )
    ).toEqual([])
  })

  it("cleans a patch temp file when local chmod fails", async () => {
    const source = join(workspace, "script.sh")
    await writeFile(source, "#!/bin/sh\necho old\n")
    await chmod(source, 0o755)
    const chmodThrough = env.chmod.bind(env)
    env.chmod = async (path, mode) => {
      if (path.includes(".north-star-")) {
        throw new Error("injected local chmod failure")
      }
      await chmodThrough(path, mode)
    }

    const result = await applyPatchTool.execute(
      {
        operations: [
          {
            type: "update",
            path: "script.sh",
            hunks: [{ old_string: "old", new_string: "new" }],
          },
        ],
      },
      { workspace, env }
    )

    expect(result).toContain("ERROR[commit_failed]")
    expect(await readFile(source, "utf8")).toBe("#!/bin/sh\necho old\n")
    expect((await env.stat(source)).mode).toBe(0o755)
    expect(
      (await env.readdir(workspace)).filter((entry) =>
        entry.name.includes(".north-star-")
      )
    ).toEqual([])
  })

  it("stat reports size and isFile", async () => {
    await writeFile(join(workspace, "f.txt"), "12345")
    const info = await env.stat(join(workspace, "f.txt"))
    expect(info.size).toBe(5)
    expect(info.isFile()).toBe(true)
    expect(info.isDirectory()).toBe(false)
  })

  it("readdir returns entries with correct isDirectory()", async () => {
    await writeFile(join(workspace, "file.txt"), "x")
    await mkdir(join(workspace, "sub"))
    const entries = await env.readdir(workspace)
    const byName = new Map(entries.map((e) => [e.name, e]))
    expect(byName.get("file.txt")!.isDirectory()).toBe(false)
    expect(byName.get("sub")!.isDirectory()).toBe(true)
  })

  it("listDir round-trips special filenames with metadata-derived types", async () => {
    const names = [
      "has\nnewline.txt",
      "has\rcarriage.txt",
      "has\ttab.txt",
      'quote"backslash\\.txt',
      "日本語🚀.txt",
      "plain-file",
      "directory\nname",
    ]
    for (const name of names) {
      if (name === "directory\nname") {
        await mkdir(join(workspace, name))
      } else {
        await writeFile(join(workspace, name), "x")
      }
    }

    const entries = await env.listDir(workspace, {
      maxEntries: 100,
      maxBytes: 1024 * 1024,
    })
    const byName = new Map(entries.entries.map((e) => [e.name, e]))

    for (const name of names) {
      expect(byName.has(name)).toBe(true)
    }
    expect(byName.get("plain-file")!.isFile()).toBe(true)
    expect(byName.get("directory\nname")!.isDirectory()).toBe(true)
  })

  it("listDir stops at entry and UTF-8 name-byte caps", async () => {
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(workspace, `日本語-${index}.txt`), "x")
    }

    const entryCapped = await env.listDir(workspace, {
      maxEntries: 3,
      maxBytes: 1024,
    })
    expect(entryCapped.entries).toHaveLength(3)
    expect(entryCapped.truncated).toBe(true)
    expect(entryCapped.capReason).toBe("entryCount")

    const byteCapped = await env.listDir(workspace, {
      maxEntries: 100,
      maxBytes: Buffer.byteLength("日本語-0.txt", "utf8") + 1,
    })
    expect(byteCapped.entries).toHaveLength(1)
    expect(byteCapped.entries[0].name).not.toContain("\ufffd")
    expect(byteCapped.truncated).toBe(true)
    expect(byteCapped.capReason).toBe("nameBytes")
  })

  it("listDir stops enumerating the source when the entry cap is reached", async () => {
    await mkdir(join(workspace, "many"))
    let yielded = 0
    const capped = new LocalEnvironment(workspace, "host-access", {
      opendir: async () =>
        fakeDir(async function* () {
          for (let index = 0; index < 50; index += 1) {
            yielded += 1
            yield dirent(`file-${index}.txt`)
          }
        }),
    })

    const result = await capped.listDir(join(workspace, "many"), {
      maxEntries: 3,
      maxBytes: 1024,
    })

    expect(result.entries.map((entry) => entry.name)).toEqual([
      "file-0.txt",
      "file-1.txt",
      "file-2.txt",
    ])
    expect(result.truncated).toBe(true)
    expect(result.capReason).toBe("entryCount")
    expect(yielded).toBe(3)
  })

  it("resolve rejects paths that escape the workspace", async () => {
    await expect(env.resolve("../outside")).rejects.toThrow()
  })

  it("resolveLexical rejects absolute paths", () => {
    expect(() => env.resolveLexical("/etc/passwd")).toThrow()
  })

  it.skipIf(process.platform === "win32")(
    "rejects a read when a parent is swapped after validation",
    async () => {
      await withParentSwapEnv("readFile", async (raceEnv, external) => {
        await writeFile(join(workspace, "safe", "sentinel.txt"), "inside")
        await writeFile(join(external, "sentinel.txt"), "outside")

        await expect(
          raceEnv.readFile(join(workspace, "safe", "sentinel.txt"))
        ).rejects.toThrow("symlink")
        expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe(
          "outside"
        )
      })
    }
  )

  it.skipIf(process.platform === "win32")(
    "rejects a write when a parent is swapped after validation",
    async () => {
      await withParentSwapEnv("writeFile", async (raceEnv, external) => {
        await writeFile(join(workspace, "safe", "sentinel.txt"), "inside")
        await writeFile(join(external, "sentinel.txt"), "outside")

        await expect(
          raceEnv.writeFile(join(workspace, "safe", "sentinel.txt"), "escaped")
        ).rejects.toThrow("symlink")
        expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe(
          "outside"
        )
      })
    }
  )

  it.skipIf(process.platform === "win32")(
    "rejects chmod when a parent is swapped after validation",
    async () => {
      await withParentSwapEnv("chmod", async (raceEnv, external) => {
        await writeFile(join(workspace, "safe", "sentinel.txt"), "inside")
        await writeFile(join(external, "sentinel.txt"), "outside")
        await chmod(join(external, "sentinel.txt"), 0o644)

        await expect(
          raceEnv.chmod(join(workspace, "safe", "sentinel.txt"), 0o755)
        ).rejects.toThrow("symlink")
        expect((await stat(join(external, "sentinel.txt"))).mode & 0o777).toBe(
          0o644
        )
      })
    }
  )

  it.skipIf(process.platform === "win32")(
    "rejects rename when a parent is swapped after validation",
    async () => {
      await withParentSwapEnv("rename:target", async (raceEnv, external) => {
        await writeFile(join(workspace, "source.txt"), "source")
        await writeFile(join(external, "renamed.txt"), "outside")

        await expect(
          raceEnv.rename(
            join(workspace, "source.txt"),
            join(workspace, "safe", "renamed.txt")
          )
        ).rejects.toThrow("symlink")
        expect(await readFile(join(external, "renamed.txt"), "utf8")).toBe(
          "outside"
        )
      })
    }
  )

  it.skipIf(process.platform === "win32")(
    "rejects no-replace installs when a parent is swapped after validation",
    async () => {
      await withParentSwapEnv("link:target", async (raceEnv, external) => {
        await writeFile(join(workspace, "source.txt"), "source")
        await writeFile(join(external, "created.txt"), "outside")

        await expect(
          raceEnv.installFileNoReplace(
            join(workspace, "source.txt"),
            join(workspace, "safe", "created.txt")
          )
        ).rejects.toThrow("symlink")
        expect(await readFile(join(external, "created.txt"), "utf8")).toBe(
          "outside"
        )
      })
    }
  )

  it.skipIf(process.platform === "win32")(
    "rejects unlink when a parent is swapped after validation",
    async () => {
      await withParentSwapEnv("unlink", async (raceEnv, external) => {
        await writeFile(join(workspace, "safe", "sentinel.txt"), "inside")
        await writeFile(join(external, "sentinel.txt"), "outside")

        await expect(
          raceEnv.removeFile(join(workspace, "safe", "sentinel.txt"))
        ).rejects.toThrow("symlink")
        expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe(
          "outside"
        )
      })
    }
  )

  it.skipIf(process.platform === "win32")(
    "rejects mkdir when a parent is swapped after validation",
    async () => {
      await withParentSwapEnv("mkdir", async (raceEnv, external) => {
        await mkdir(join(external, "child"), { recursive: true })

        await expect(
          raceEnv.mkdirp(join(workspace, "safe", "child", "nested"))
        ).rejects.toThrow("symlink")
        expect(await readdir(join(external, "child"))).toEqual([])
      })
    }
  )

  it.skipIf(process.platform === "win32")(
    "rejects directory listing when a parent is swapped after validation",
    async () => {
      await withParentSwapEnv("listDir", async (raceEnv, external) => {
        await writeFile(join(external, "external.txt"), "outside")

        await expect(raceEnv.readdir(join(workspace, "safe"))).rejects.toThrow(
          "symlink"
        )
      })
    }
  )

  it.skipIf(process.platform === "win32")(
    "does not read through a parent swapped to an external symlink after resolve",
    async () => {
      const external = await mkdtemp(join(tmpdir(), "env-local-external-"))
      try {
        await mkdir(join(workspace, "safe"))
        await writeFile(join(workspace, "safe", "sentinel.txt"), "inside")
        await writeFile(join(external, "sentinel.txt"), "outside")
        const target = await env.resolve("safe/sentinel.txt")

        await rm(join(workspace, "safe"), { recursive: true, force: true })
        await symlink(external, join(workspace, "safe"))

        await expect(env.readFile(target)).rejects.toThrow()
        expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe(
          "outside"
        )
      } finally {
        await rm(external, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === "win32")(
    "does not write through a parent swapped to an external symlink after resolve",
    async () => {
      const external = await mkdtemp(join(tmpdir(), "env-local-external-"))
      try {
        await mkdir(join(workspace, "safe"))
        await writeFile(join(workspace, "safe", "sentinel.txt"), "inside")
        await writeFile(join(external, "sentinel.txt"), "outside")
        const target = await env.resolve("safe/sentinel.txt")

        await rm(join(workspace, "safe"), { recursive: true, force: true })
        await symlink(external, join(workspace, "safe"))

        await expect(env.writeFile(target, "escaped")).rejects.toThrow()
        expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe(
          "outside"
        )
      } finally {
        await rm(external, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === "win32")(
    "does not list through a parent swapped to an external symlink after resolve",
    async () => {
      const external = await mkdtemp(join(tmpdir(), "env-local-external-"))
      try {
        await mkdir(join(workspace, "safe"))
        await writeFile(join(external, "external.txt"), "outside")
        const target = await env.resolve("safe")

        await rm(join(workspace, "safe"), { recursive: true, force: true })
        await symlink(external, join(workspace, "safe"))

        await expect(env.readdir(target)).rejects.toThrow()
      } finally {
        await rm(external, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(!localProfileCapabilities("read-only").supported)(
    "blocks filesystem writes in the read-only profile",
    async () => {
      const readOnly = new LocalEnvironment(workspace, "read-only")
      expect(() =>
        readOnly.writeFile(join(workspace, "blocked.txt"), "x")
      ).toThrow("read-only profile blocks")
    }
  )

  it.skipIf(!localProfileCapabilities("workspace-write").supported)(
    "blocks writes outside the workspace in the workspace-write profile",
    async () => {
      const workspaceWrite = new LocalEnvironment(workspace, "workspace-write")
      await workspaceWrite.writeFile(join(workspace, "ok.txt"), "x")
      expect(() =>
        workspaceWrite.writeFile("/outside-local-profile.txt", "x")
      ).toThrow("outside the workspace")
    }
  )
})

describe("Local runtime profiles", () => {
  it("always supports explicit host access", () => {
    expect(localProfileCapabilities("host-access", "linux")).toEqual({
      supported: true,
    })
  })

  it("refuses stronger local labels on platforms without an adapter", () => {
    expect(localProfileCapabilities("read-only", "linux").supported).toBe(false)
  })

  it("builds a macOS read-only profile that denies writes and network", () => {
    const profile = buildDarwinSandboxProfile("read-only", "/repo")
    expect(profile).toContain("(deny network*)")
    expect(profile).toContain("(deny file-write*)")
    expect(profile).not.toContain("allow file-write")
  })

  it("builds a macOS workspace-write profile limited to workspace/temp writes", () => {
    const profile = buildDarwinSandboxProfile("workspace-write", "/repo")
    expect(profile).toContain('(allow file-write* (subpath "/repo"))')
    expect(profile).toContain('(allow file-write* (subpath "/private/tmp"))')
    expect(profile).toContain("(deny network*)")
  })
})

describe("LocalEnvironment.readTextLines", () => {
  it("pages through files larger than the old whole-file cap", async () => {
    const target = join(workspace, "large.txt")
    await writeFile(target, "first\n")
    const chunk = Buffer.alloc(1024 * 1024, "x")
    for (let i = 0; i < 34; i += 1) {
      await appendFile(target, chunk)
    }
    await appendFile(target, "\nlast\n")

    const first = await env.readTextLines(target, {
      offset: 1,
      limit: 1,
      maxBytes: 1024,
    })
    const final = await env.readTextLines(target, {
      offset: 3,
      limit: 1,
      maxBytes: 1024,
    })

    expect(first).toMatchObject({
      text: "first",
      startLine: 1,
      endLine: 1,
      hasMore: true,
      nextOffset: 2,
    })
    expect(final).toMatchObject({
      text: "last",
      startLine: 3,
      endLine: 3,
      hasMore: false,
      truncated: false,
    })
    expect(final.fileBytes).toBeGreaterThan(32 * 1024 * 1024)
    expect(final.revision).toMatch(/^[a-f0-9]{64}$/)
  })

  it("reads an early page with bounded source reads and without hashing to EOF", async () => {
    const target = join(workspace, "large-streamed.txt")
    await writeFile(target, "first\n")
    const chunk = Buffer.alloc(1024 * 1024, "x")
    for (let i = 0; i < 16; i += 1) {
      await appendFile(target, chunk)
    }
    await appendFile(target, "\nlast\n")

    let bytesRead = 0
    let largestRead = 0
    const streamingEnv = new LocalEnvironment(workspace, "host-access", {
      openNoFollow: async (path, flags, mode) => {
        const handle = await fsOpen(path, flags, mode)
        return trackHandleReads(handle, {
          onRead: (size, requested) => {
            bytesRead += size
            largestRead = Math.max(largestRead, requested)
          },
        })
      },
    })

    const result = await streamingEnv.readTextLines(target, {
      offset: 1,
      limit: 1,
      maxBytes: 1024,
    })

    expect(result).toMatchObject({
      text: "first",
      startLine: 1,
      endLine: 1,
      hasMore: true,
      nextOffset: 2,
    })
    expect(result.fileBytes).toBeGreaterThan(16 * 1024 * 1024)
    expect(result.revision).toBeUndefined()
    expect(bytesRead).toBeLessThan(1024 * 1024)
    expect(largestRead).toBeLessThanOrEqual(64 * 1024)
  })

  it("preserves UTF-8 characters and reports byte truncation metadata", async () => {
    await writeFile(join(workspace, "utf8.txt"), "alpha\n日本語 café 🚀\nomega")
    const result = await env.readTextLines(join(workspace, "utf8.txt"), {
      offset: 2,
      limit: 10,
      maxBytes: 20,
    })
    expect(result.text).toBe("日本語 café 🚀")
    expect(result).toMatchObject({
      startLine: 2,
      endLine: 2,
      hasMore: true,
      nextOffset: 3,
      truncated: true,
    })
    expect(result.text).not.toContain("�")
  })

  it("returns a bounded UTF-8 prefix and advances past an oversized line", async () => {
    await writeFile(
      join(workspace, "long.txt"),
      `${"日本語".repeat(1000)}\nsecond`
    )
    const first = await env.readTextLines(join(workspace, "long.txt"), {
      offset: 1,
      limit: 10,
      maxBytes: 14,
    })
    const next = await env.readTextLines(join(workspace, "long.txt"), {
      offset: first.nextOffset!,
      limit: 10,
      maxBytes: 14,
    })

    expect(Buffer.byteLength(first.text, "utf8")).toBeLessThanOrEqual(14)
    expect(first).toMatchObject({
      startLine: 1,
      endLine: 1,
      hasMore: true,
      nextOffset: 2,
      truncated: true,
      lineTooLong: true,
      skippedLineRemainder: true,
    })
    expect(first.text).not.toContain("�")
    expect(next).toMatchObject({
      text: "second",
      startLine: 2,
      endLine: 2,
      hasMore: false,
      truncated: false,
    })
    expect(next.text).not.toContain("�")
  })

  it("rejects binary files based on the initial chunk", async () => {
    await writeFile(join(workspace, "bin.dat"), Buffer.from([65, 0, 66]))
    await expect(
      env.readTextLines(join(workspace, "bin.dat"), {
        offset: 1,
        limit: 10,
        maxBytes: 1024,
      })
    ).rejects.toThrow("BINARY_FILE")
  })
})

function trackHandleReads(
  handle: FileHandle,
  opts: { onRead: (bytesRead: number, requestedBytes: number) => void }
): FileHandle {
  return new Proxy(handle, {
    get(target, prop, receiver) {
      if (prop === "read") {
        return async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null
        ) => {
          const result = await target.read(buffer, offset, length, position)
          opts.onRead(result.bytesRead, length)
          return result
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as FileHandle
}

function fakeDir(factory: () => AsyncGenerator<DirentLike>): Dir {
  return {
    close: async () => {},
    [Symbol.asyncIterator]: factory,
  } as unknown as Dir
}

interface DirentLike {
  name: string
  isFile: () => boolean
  isDirectory: () => boolean
}

function dirent(name: string): DirentLike {
  return {
    name,
    isFile: () => true,
    isDirectory: () => false,
  }
}

describe("LocalEnvironment.search", () => {
  const baseOpts = {
    maxFileBytes: 1024 * 1024,
    maxResults: 100,
    mode: "fixed" as const,
    case: "smart" as const,
    globs: [] as string[],
    result: "content" as const,
    beforeContext: 0,
    afterContext: 0,
    includeHidden: false,
    respectIgnore: true,
  }

  it("finds a matching line and reports its path + line number", async () => {
    await writeFile(join(workspace, "a.txt"), "first\nneedle here\nthird")
    const { matches, capped } = await env.search({
      root: workspace,
      query: "needle",
      ...baseOpts,
    })
    expect(capped).toBe(false)
    expect(matches[0].column).toBe(1)
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ line: 2, text: "needle here" })
    expect(matches[0].path).toBe(join(workspace, "a.txt"))
  })

  it.skipIf(process.platform === "win32")(
    "does not search through a parent swapped to an external symlink after resolve",
    async () => {
      const external = await mkdtemp(join(tmpdir(), "env-local-external-"))
      try {
        await mkdir(join(workspace, "safe"))
        await writeFile(join(external, "sentinel.txt"), "needle outside")
        const root = await env.resolve("safe")

        await rm(join(workspace, "safe"), { recursive: true, force: true })
        await symlink(external, join(workspace, "safe"))

        await expect(
          env.search({
            root,
            query: "needle",
            ...baseOpts,
          })
        ).rejects.toThrow()
      } finally {
        await rm(external, { recursive: true, force: true })
      }
    }
  )

  it("honors ripgrep include/exclude globs", async () => {
    await mkdir(join(workspace, "node_modules"))
    await writeFile(join(workspace, "node_modules", "dep.ts"), "match")
    await writeFile(join(workspace, "keep.ts"), "match")
    await writeFile(join(workspace, "keep.md"), "match")
    const { matches } = await env.search({
      root: workspace,
      query: "match",
      ...baseOpts,
      globs: ["*.ts", "!**/node_modules/**"],
    })
    expect(matches).toHaveLength(1)
    expect(matches[0].path).toBe(join(workspace, "keep.ts"))
  })

  it("caps at maxResults", async () => {
    await writeFile(join(workspace, "many.txt"), "x\nx\nx\nx\nx")
    const { matches, capped } = await env.search({
      root: workspace,
      query: "x",
      ...baseOpts,
      maxResults: 3,
    })
    expect(matches).toHaveLength(3)
    expect(capped).toBe(true)
  })

  it("reports ripgrep capture truncation before maxResults", async () => {
    await writeFile(
      join(workspace, "large.txt"),
      `needle ${"x".repeat(4000)}\nneedle ${"y".repeat(4000)}\n`
    )
    const cappedEnv = new LocalEnvironment(workspace, "host-access", {
      searchMaxOutputBytes: 600,
    })

    const result = await cappedEnv.search({
      root: workspace,
      query: "needle",
      ...baseOpts,
      maxResults: 100,
    })

    expect(result.matches.length).toBeLessThan(100)
    expect(result.capped).toBe(true)
    expect(result.captureTruncated).toBe(true)
    expect(result.capReason).toBe("captureBytes")
    expect(result.capturedOutputBytes).toBe(600)
    expect(result.observedOutputBytes).toBeGreaterThan(600)
    expect(result.malformedJsonLines).toBeGreaterThan(0)
  })

  it("skips binary files", async () => {
    await writeFile(join(workspace, "bin.dat"), Buffer.from([0x6d, 0x00, 0x6d]))
    const { matches } = await env.search({
      root: workspace,
      query: "m",
      ...baseOpts,
    })
    expect(matches).toHaveLength(0)
  })

  it("treats fixed queries with regex and shell metacharacters as data", async () => {
    await writeFile(join(workspace, "literal.txt"), "a+b $(echo nope) --flag")
    const { matches } = await env.search({
      root: workspace,
      query: "a+b $(echo nope) --flag",
      ...baseOpts,
    })
    expect(matches).toHaveLength(1)
    expect(matches[0].text).toBe("a+b $(echo nope) --flag")
  })

  it("supports regex mode and smart case", async () => {
    await writeFile(join(workspace, "regex.txt"), "alpha-123\nAlpha-456")
    const { matches } = await env.search({
      root: workspace,
      query: "alpha-\\d+",
      ...baseOpts,
      mode: "regex",
      case: "smart",
    })
    expect(matches.map((m) => m.text)).toEqual(["alpha-123", "Alpha-456"])
  })

  it("reports missing ripgrep as search infrastructure unavailable", async () => {
    const missing = new LocalEnvironment(workspace, "host-access", {
      resolveRipgrepPath: () => join(workspace, "missing-rg"),
    })

    await expect(
      missing.search({ root: workspace, query: "x", ...baseOpts })
    ).rejects.toMatchObject({
      code: "search_unavailable",
    } satisfies Partial<SearchExecutionError>)
  })

  it.skipIf(process.platform === "win32")(
    "reports non-executable ripgrep as search infrastructure unavailable",
    async () => {
      const blockedPath = join(workspace, "blocked-rg")
      await writeFile(blockedPath, "#!/bin/sh\nexit 0\n")
      await chmod(blockedPath, 0o644)
      const blocked = new LocalEnvironment(workspace, "host-access", {
        resolveRipgrepPath: () => blockedPath,
      })

      await expect(
        blocked.search({ root: workspace, query: "x", ...baseOpts })
      ).rejects.toMatchObject({
        code: "search_unavailable",
      } satisfies Partial<SearchExecutionError>)
    }
  )

  it.skipIf(process.platform === "win32")(
    "reports timed-out ripgrep as a failed search",
    async () => {
      const slowPath = join(workspace, "slow-rg")
      await writeFile(
        slowPath,
        `#!${process.execPath}\nsetTimeout(() => {}, 10_000)\n`
      )
      await chmod(slowPath, 0o755)
      const slow = new LocalEnvironment(workspace, "host-access", {
        resolveRipgrepPath: () => slowPath,
        searchTimeoutMs: 50,
      })

      await expect(
        slow.search({ root: workspace, query: "x", ...baseOpts })
      ).rejects.toMatchObject({
        code: "search_failed",
      } satisfies Partial<SearchExecutionError>)
    }
  )

  it.skipIf(process.platform === "win32")(
    "reports aborted ripgrep as cancellation",
    async () => {
      const slowPath = join(workspace, "aborted-rg")
      await writeFile(
        slowPath,
        `#!${process.execPath}\nsetTimeout(() => {}, 10_000)\n`
      )
      await chmod(slowPath, 0o755)
      const ac = new AbortController()
      const aborted = new LocalEnvironment(workspace, "host-access", {
        resolveRipgrepPath: () => slowPath,
        searchTimeoutMs: 30_000,
      })
      const search = aborted.search({
        root: workspace,
        query: "x",
        ...baseOpts,
        signal: ac.signal,
      })
      setTimeout(() => ac.abort(), 50)

      await expect(search).rejects.toMatchObject({
        code: "aborted",
      } satisfies Partial<SearchExecutionError>)
    }
  )

  it("reports ripgrep regex parse failures as pattern errors", async () => {
    await expect(
      env.search({
        root: workspace,
        query: "[",
        ...baseOpts,
        mode: "regex",
      })
    ).rejects.toBeInstanceOf(SearchPatternError)
  })

  it("treats invalid regex syntax as data in fixed-string mode", async () => {
    await writeFile(join(workspace, "literal-regex.txt"), "[")
    const { matches } = await env.search({
      root: workspace,
      query: "[",
      ...baseOpts,
      mode: "fixed",
    })
    expect(matches).toHaveLength(1)
    expect(matches[0].text).toBe("[")
  })

  it("returns files and count result modes", async () => {
    await writeFile(join(workspace, "one.txt"), "needle needle\n")
    await writeFile(join(workspace, "two.txt"), "needle\n")

    const files = await env.search({
      root: workspace,
      query: "needle",
      ...baseOpts,
      result: "files",
    })
    const count = await env.search({
      root: workspace,
      query: "needle",
      ...baseOpts,
      result: "count",
    })

    expect(files.files.map((p) => p.split(/[\\/]/).pop()).sort()).toEqual([
      "one.txt",
      "two.txt",
    ])
    expect(count.totalMatches).toBe(3)
    expect(
      Object.fromEntries(
        count.counts.map((c) => [c.path.split(/[\\/]/).pop(), c.matches])
      )
    ).toEqual({ "one.txt": 2, "two.txt": 1 })
  })
})

describe("scheduler backend cancellation", () => {
  it("propagates a deadline to the real local process and reaps it", async () => {
    let backend!: ReturnType<LocalEnvironment["exec"]>
    const results = await runToolCallBatches(
      [{ id: "command", name: "command", arguments: "{}" }],
      {
        effectsFor: () => TOOL_EFFECTS.openWorldMutation,
        policyFor: () => ({ timeoutMs: 100 }),
        execute: async (_call, _index, signal) => {
          backend = env.exec(nodeCmd("setInterval(() => {}, 1000)"), {
            cwd: workspace,
            timeoutMs: 5000,
            maxOutputBytes: 1024,
            signal,
          })
          const output = await backend
          return { result: String(output.exitCode) }
        },
      }
    )
    expect(results[0].outcome).toBe("unknown")
    // Await the backend's close event, not merely the scheduler's race result.
    const output = await backend
    expect(output.aborted).toBe(true)
    expect(output.exitCode).not.toBe(0)
  })
})

it("stops paged reads between chunks and closes the file handle on cancellation", async () => {
  const abort = new AbortController()
  const target = join(workspace, "cancel-read.txt")
  await writeFile(target, "line\n".repeat(50000))
  let opened!: FileHandle
  let reads = 0
  const readingEnv = new LocalEnvironment(workspace, "host-access", {
    openNoFollow: async (path, flags, mode) => {
      opened = await fsOpen(path, flags, mode)
      return trackHandleReads(opened, {
        onRead: () => {
          reads++
          abort.abort(new Error("stop read"))
        },
      })
    },
  })
  await expect(
    readingEnv.readTextLines(target, {
      offset: 40000,
      limit: 1,
      maxBytes: 1024,
      signal: abort.signal,
    })
  ).rejects.toThrow("stop read")
  expect(reads).toBe(1)
  expect(opened.fd).toBe(-1)
})

// Regression coverage for .debug/097: a GUI-launched Electron process carries a
// minimal PATH, and the captured shell (/bin/sh -c) sources no dotfiles, so
// Local commands used to miss anything installed through the user's login shell.
// These tests use a synthetic executable and a synthetic normalized environment,
// so they never depend on the developer machine's node manager, pnpm, or shell.
describe.skipIf(process.platform === "win32")(
  "LocalEnvironment host environment",
  () => {
    const SENTINEL = "ns-sentinel-tool"
    let binDir: string
    let hostEnvCalls: number

    const hostEnvWith = (extra: NodeJS.ProcessEnv = {}) => {
      hostEnvCalls = 0
      return async () => {
        hostEnvCalls++
        return { ...extra, PATH: binDir } as NodeJS.ProcessEnv
      }
    }

    const collect = (handle: CommandSessionHandle) =>
      new Promise<string>((resolve) => {
        let out = ""
        handle.onData((chunk) => {
          out += chunk.data.toString("utf8")
        })
        handle.onExit(() => resolve(out))
      })

    beforeEach(async () => {
      binDir = await mkdtemp(join(tmpdir(), "env-sentinel-bin-"))
      const script = join(binDir, SENTINEL)
      await writeFile(script, "#!/bin/sh\necho sentinel-ok\n", "utf8")
      await chmod(script, 0o755)
    })
    afterEach(async () => {
      await rm(binDir, { recursive: true, force: true })
    })

    it("resolves an executable found only on the normalized host PATH", async () => {
      const local = new LocalEnvironment(workspace, "host-access", {
        hostCliEnv: hostEnvWith(),
      })
      const r = await local.exec(SENTINEL, {
        cwd: workspace,
        timeoutMs: 5000,
        maxOutputBytes: 1024,
      })

      expect(r.exitCode).toBe(0)
      expect(r.stdout.toString("utf8").trim()).toBe("sentinel-ok")
    })

    it("still fails when the normalized environment does not contain it", async () => {
      const local = new LocalEnvironment(workspace, "host-access", {
        hostCliEnv: async () => ({ ...process.env, PATH: "/usr/bin:/bin" }),
      })
      const r = await local.exec(SENTINEL, {
        cwd: workspace,
        timeoutMs: 5000,
        maxOutputBytes: 1024,
      })

      expect(r.exitCode).toBe(127)
    })

    it("resolves the same executable through a non-TTY command session", async () => {
      const local = new LocalEnvironment(workspace, "host-access", {
        hostCliEnv: hostEnvWith(),
      })
      const handle = await local.spawnCommand(SENTINEL, {
        cwd: workspace,
        tty: false,
      })

      expect((await collect(handle)).trim()).toBe("sentinel-ok")
    })

    it("resolves the same executable through a TTY command session", async () => {
      const local = new LocalEnvironment(workspace, "host-access", {
        hostCliEnv: hostEnvWith(),
      })
      const handle = await local.spawnCommand(SENTINEL, {
        cwd: workspace,
        tty: true,
      })

      expect(await collect(handle)).toContain("sentinel-ok")
    })

    it("passes the normalized environment to execFile", async () => {
      const local = new LocalEnvironment(workspace, "host-access", {
        hostCliEnv: hostEnvWith({ NS_SENTINEL_VAR: "from-host-env" }),
      })
      const r = await local.execFile(
        process.execPath,
        ["-e", "process.stdout.write(String(process.env.NS_SENTINEL_VAR))"],
        { cwd: workspace, timeoutMs: 5000, maxOutputBytes: 1024 }
      )

      expect(r.stdout.toString("utf8")).toBe("from-host-env")
    })

    it("lets an explicit execFile env override the normalized value", async () => {
      const local = new LocalEnvironment(workspace, "host-access", {
        hostCliEnv: hostEnvWith({ NS_SENTINEL_VAR: "from-host-env" }),
      })
      const r = await local.execFile(
        process.execPath,
        ["-e", "process.stdout.write(String(process.env.NS_SENTINEL_VAR))"],
        {
          cwd: workspace,
          timeoutMs: 5000,
          maxOutputBytes: 1024,
          env: { NS_SENTINEL_VAR: "explicit-override" },
        }
      )

      expect(r.stdout.toString("utf8")).toBe("explicit-override")
    })

    it("carries login-shell variables beyond PATH into commands", async () => {
      const local = new LocalEnvironment(workspace, "host-access", {
        hostCliEnv: hostEnvWith({ PNPM_HOME: "/synthetic/pnpm" }),
      })
      const r = await local.exec('printf "%s" "$PNPM_HOME"', {
        cwd: workspace,
        timeoutMs: 5000,
        maxOutputBytes: 1024,
      })

      expect(r.stdout.toString("utf8")).toBe("/synthetic/pnpm")
    })

    it("keeps commands runnable when the login-shell probe fails", async () => {
      const local = new LocalEnvironment(workspace, "host-access", {
        hostCliEnv: async () => {
          throw new Error("login shell probe failed")
        },
      })
      const r = await local.exec("echo still-running", {
        cwd: workspace,
        timeoutMs: 5000,
        maxOutputBytes: 1024,
      })

      expect(r.exitCode).toBe(0)
      expect(r.stdout.toString("utf8").trim()).toBe("still-running")
    })

    it("resolves the host environment once per environment instance", async () => {
      const local = new LocalEnvironment(workspace, "host-access", {
        hostCliEnv: hostEnvWith(),
      })
      const opts = { cwd: workspace, timeoutMs: 5000, maxOutputBytes: 1024 }
      await local.exec(SENTINEL, opts)
      await local.exec(SENTINEL, opts)
      await local.execFile(process.execPath, ["-e", ""], opts)

      expect(hostEnvCalls).toBe(1)
    })

    it.skipIf(process.platform !== "darwin")(
      "resolves it under the sandboxed workspace-write profile too",
      async () => {
        const local = new LocalEnvironment(workspace, "workspace-write", {
          hostCliEnv: hostEnvWith(),
        })
        const r = await local.exec(SENTINEL, {
          cwd: workspace,
          timeoutMs: 5000,
          maxOutputBytes: 1024,
        })

        expect(r.exitCode).toBe(0)
        expect(r.stdout.toString("utf8").trim()).toBe("sentinel-ok")
      }
    )
  }
)
