import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execSync } from "child_process"
import { mkdtemp, rm, readFile, writeFile, mkdir, chmod } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import {
  LocalEnvironment,
  materializePythonHeredocCommand,
  normalizeHostShellCommand,
} from "./local"
import { SearchExecutionError, SearchPatternError } from "./ripgrep"
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
  it("writes and reads a file, round-tripping bytes", async () => {
    const target = await env.resolve("note.txt")
    await env.writeFile(target, "hi there")
    const buf = await env.readFile(target)
    expect(buf.toString("utf8")).toBe("hi there")
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

  it("resolve rejects paths that escape the workspace", async () => {
    await expect(env.resolve("../outside")).rejects.toThrow()
  })

  it("resolveLexical rejects absolute paths", () => {
    expect(() => env.resolveLexical("/etc/passwd")).toThrow()
  })

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
    const lines = Array.from({ length: 12_000 }, (_, i) => `line-${i + 1}`)
    await writeFile(join(workspace, "large.txt"), `${lines.join("\n")}\n`)

    const first = await env.readTextLines(join(workspace, "large.txt"), {
      offset: 1,
      limit: 3,
      maxBytes: 256 * 1024,
    })
    const middle = await env.readTextLines(join(workspace, "large.txt"), {
      offset: first.nextOffset!,
      limit: 3,
      maxBytes: 256 * 1024,
    })
    const final = await env.readTextLines(join(workspace, "large.txt"), {
      offset: 11_999,
      limit: 3,
      maxBytes: 256 * 1024,
    })

    expect(first).toMatchObject({
      text: "line-1\nline-2\nline-3",
      startLine: 1,
      endLine: 3,
      hasMore: true,
      nextOffset: 4,
    })
    expect(middle.text).toBe("line-4\nline-5\nline-6")
    expect(final).toMatchObject({
      text: "line-11999\nline-12000",
      startLine: 11999,
      endLine: 12000,
      hasMore: false,
      truncated: false,
    })
    expect(final.revision).toMatch(/^[a-f0-9]{64}$/)
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

  it("returns a bounded UTF-8 prefix for a single oversized line", async () => {
    await writeFile(join(workspace, "long.txt"), "日本語".repeat(1000))
    const result = await env.readTextLines(join(workspace, "long.txt"), {
      offset: 1,
      limit: 10,
      maxBytes: 14,
    })
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(14)
    expect(result).toMatchObject({
      startLine: 1,
      endLine: 1,
      hasMore: true,
      nextOffset: 1,
      truncated: true,
      lineTooLong: true,
    })
    expect(result.text).not.toContain("�")
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
