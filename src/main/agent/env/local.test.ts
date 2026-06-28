import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execSync } from "child_process"
import { mkdtemp, rm, readFile, writeFile, mkdir } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { LocalEnvironment } from "./local"

let workspace: string
let env: LocalEnvironment

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
    const r = await env.exec("exit 3", {
      cwd: workspace,
      timeoutMs: 5000,
      maxOutputBytes: 1024 * 1024,
    })
    expect(r.exitCode).toBe(3)
  })

  it("times out a long-running command", async () => {
    const r = await env.exec("sleep 5", {
      cwd: workspace,
      timeoutMs: 100,
      maxOutputBytes: 1024 * 1024,
    })
    expect(r.timedOut).toBe(true)
  })

  it("preserves multibyte UTF-8 (decodes the Buffer once)", async () => {
    const r = await env.exec("printf '日本語 — café 🚀'", {
      cwd: workspace,
      timeoutMs: 5000,
      maxOutputBytes: 1024 * 1024,
    })
    const out = r.stdout.toString("utf8")
    expect(out).toContain("日本語 — café 🚀")
    expect(out).not.toContain("�") // no replacement chars
  })

  it("kills the command when the signal aborts (and only then)", async () => {
    const ac = new AbortController()
    const p = env.exec("sleep 5", {
      cwd: workspace,
      timeoutMs: 5000,
      maxOutputBytes: 1024 * 1024,
      signal: ac.signal,
    })
    setTimeout(() => ac.abort(), 50)
    const r = await p
    // Killed before the 5s timeout fired.
    expect(r.timedOut).toBe(false)
    expect(r.signal).toBe("SIGKILL")
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

  it("reaps the whole process group on abort (no orphaned grandchild)", async () => {
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
  })

  it("reaps the whole process group on timeout (no orphaned grandchild)", async () => {
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
})

describe("LocalEnvironment.search", () => {
  const baseOpts = {
    skipDirs: [".git", "node_modules"],
    maxFileBytes: 1024 * 1024,
    maxResults: 100,
  }

  it("finds a matching line and reports its path + line number", async () => {
    await writeFile(join(workspace, "a.txt"), "first\nneedle here\nthird")
    const { matches, capped } = await env.search({
      root: workspace,
      pattern: "needle",
      ...baseOpts,
    })
    expect(capped).toBe(false)
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ line: 2, text: "needle here" })
    expect(matches[0].path).toBe(join(workspace, "a.txt"))
  })

  it("prunes skipDirs and honors the glob filter", async () => {
    await mkdir(join(workspace, "node_modules"))
    await writeFile(join(workspace, "node_modules", "dep.ts"), "match")
    await writeFile(join(workspace, "keep.ts"), "match")
    await writeFile(join(workspace, "keep.md"), "match")
    const { matches } = await env.search({
      root: workspace,
      pattern: "match",
      glob: ".ts",
      ...baseOpts,
    })
    expect(matches).toHaveLength(1)
    expect(matches[0].path).toBe(join(workspace, "keep.ts"))
  })

  it("caps at maxResults", async () => {
    await writeFile(join(workspace, "many.txt"), "x\nx\nx\nx\nx")
    const { matches, capped } = await env.search({
      root: workspace,
      pattern: "x",
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
      pattern: "m",
      ...baseOpts,
    })
    expect(matches).toHaveLength(0)
  })
})
