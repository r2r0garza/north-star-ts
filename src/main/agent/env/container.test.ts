import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { mkdtemp, rm, readFile, writeFile, symlink } from "fs/promises"
import { hostname, tmpdir } from "os"
import { join } from "path"
import { EventEmitter } from "events"
import { PassThrough } from "stream"
import { spawn } from "child_process"
import type { ChildProcess } from "child_process"
import { ContainerEnvironment } from "./container"
import { checkContainerTestAvailability } from "./container-test-availability"
import { applyPatchTool } from "../tools/apply_patch_tool"
import { editFileTool } from "../tools/edit_file_tool"
import { listFilesTool } from "../tools/list_files_tool"
import { readFileTool } from "../tools/read_file_tool"
import { searchTool } from "../tools/search_tool"
import { writeFileTool } from "../tools/write_file_tool"

const IMAGE = process.env.COWORK_ENV_IMAGE || "node:20-bookworm"

type FakeRuntimeChild = ChildProcess & {
  stdout: PassThrough
  stderr: PassThrough
  stdin: PassThrough
  kill: ReturnType<typeof vi.fn>
}

function fakeRuntimeChild(opts: {
  stdout?: string
  stderr?: string
  code?: number
  neverExit?: boolean
}): FakeRuntimeChild {
  const child = new EventEmitter() as FakeRuntimeChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  Object.defineProperty(child, "pid", {
    value: Math.floor(Math.random() * 10_000) + 1_000,
  })
  child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    setImmediate(() => {
      child.stdout.end()
      child.stderr.end()
      child.emit("close", null, typeof signal === "string" ? signal : "SIGKILL")
    })
    return true
  })
  setImmediate(() => {
    if (opts.stdout) child.stdout.write(opts.stdout)
    if (opts.stderr) child.stderr.write(opts.stderr)
    if (!opts.neverExit) {
      child.stdout.end()
      child.stderr.end()
      child.emit("close", opts.code ?? 0, null)
    }
  })
  return child
}

function testContainer(
  runtimeSpawn: (...args: Parameters<typeof spawn>) => ChildProcess,
  cfg: Partial<ConstructorParameters<typeof ContainerEnvironment>[0]> = {}
): ContainerEnvironment {
  return new ContainerEnvironment({
    runtime: "docker",
    image: IMAGE,
    workspace: "/tmp/workspace",
    conversationId: `unit-${Math.random()}`,
    hostCliEnv: async () => ({}),
    runtimeSpawn: runtimeSpawn as typeof spawn,
    ...cfg,
  })
}

describe("ContainerEnvironment runtime CLI supervision", () => {
  it("times out and reaps a hung startup probe", async () => {
    const child = fakeRuntimeChild({ neverExit: true })
    const env = testContainer(() => child, { runtimeCliTimeoutMs: 10 })

    await expect(env.start()).rejects.toThrow(/timed out/)

    expect(child.kill).toHaveBeenCalledWith("SIGKILL")
  })

  it("rejects truncated JSON instead of parsing it as complete", async () => {
    const env = testContainer(
      () => fakeRuntimeChild({ stdout: '{"path": "/workspace/file.txt"}' }),
      { runtimeCliMaxOutputBytes: 8 }
    )

    await expect(env.resolve("file.txt")).rejects.toThrow(/output cap/)
  })

  it("rejects truncated base64 file output instead of returning partial bytes", async () => {
    const runtimeSpawn = vi
      .fn()
      .mockReturnValueOnce(
        fakeRuntimeChild({ stdout: '{"path": "/workspace/file.txt"}' })
      )
      .mockReturnValueOnce(
        fakeRuntimeChild({ stdout: Buffer.from("abcdef").toString("base64") })
      )
    const env = testContainer(runtimeSpawn, {
      runtimeCliReadFileMaxOutputBytes: 4,
    })

    await expect(env.readFile("/workspace/file.txt")).rejects.toThrow(
      /output cap/
    )
  })

  it("propagates search aborts to the runtime CLI probe", async () => {
    const child = fakeRuntimeChild({ neverExit: true })
    const env = testContainer(() => child)
    const ac = new AbortController()
    ac.abort()

    await expect(
      env.search({
        root: "/workspace",
        query: "needle",
        mode: "fixed",
        case: "smart",
        globs: [],
        result: "content",
        beforeContext: 0,
        afterContext: 0,
        includeHidden: false,
        respectIgnore: true,
        maxFileBytes: 1024,
        maxResults: 10,
        signal: ac.signal,
      })
    ).rejects.toThrow(/aborted/)

    expect(child.kill).toHaveBeenCalledWith("SIGKILL")
  })

  it("runs bounded in-container cleanup before returning a timed-out exec", async () => {
    const commandChild = fakeRuntimeChild({ neverExit: true })
    const cleanupChild = fakeRuntimeChild({})
    const runtimeSpawn = vi
      .fn()
      .mockReturnValueOnce(commandChild)
      .mockReturnValueOnce(cleanupChild)
    const env = testContainer(runtimeSpawn, { runtimeCliTimeoutMs: 10 })

    const result = await env.exec("sleep 30", {
      cwd: "/tmp/workspace",
      timeoutMs: 10,
      maxOutputBytes: 1024,
    })

    expect(result.timedOut).toBe(true)
    expect(commandChild.kill).toHaveBeenCalledWith("SIGKILL")
    expect(runtimeSpawn).toHaveBeenCalledTimes(2)
    const cleanupArgs = runtimeSpawn.mock.calls[1][1] as string[]
    expect(cleanupArgs).toContain("python3")
    expect(cleanupArgs).toContain("KILL")
  })
})

// One shared suite body, run once per available runtime.
for (const runtime of ["docker", "podman"] as const) {
  const availability = checkContainerTestAvailability(runtime, IMAGE)
  describe.skipIf(!availability.shouldRun)(
    `ContainerEnvironment (${runtime})`,
    () => {
      let workspace: string
      let env: ContainerEnvironment

      beforeAll(async () => {
        if (!availability.available) {
          throw new Error(
            `Container integration tests requested for ${runtime}, but the runtime is not usable: ${availability.reason}`
          )
        }
        workspace = await mkdtemp(join(tmpdir(), `env-${runtime}-`))
        env = new ContainerEnvironment({
          runtime,
          image: IMAGE,
          workspace,
          conversationId: `test-${runtime}-${process.pid}`,
        })
        await env.start()
      }, 120_000)

      afterAll(async () => {
        if (env) await env.dispose()
        if (workspace) await rm(workspace, { recursive: true, force: true })
      }, 60_000)

      it("execs inside the container (hostname differs from host)", async () => {
        const r = await env.exec("hostname", {
          cwd: workspace,
          timeoutMs: 10_000,
          maxOutputBytes: 1024 * 1024,
        })
        expect(r.exitCode).toBe(0)
        expect(r.stdout.toString("utf8").trim()).not.toBe(hostname())
      })

      it("reaps an in-container child process on exec timeout", async () => {
        const sentinel = "exec-timeout-survivor.txt"
        const r = await env.exec(
          `sh -c 'sleep 1; echo late > ${sentinel}' & wait`,
          {
            cwd: workspace,
            timeoutMs: 100,
            maxOutputBytes: 1024 * 1024,
          }
        )

        expect(r.timedOut).toBe(true)
        await delay(1_300)
        await expect(
          readFile(join(workspace, sentinel), "utf8")
        ).rejects.toThrow()
      })

      it("reaps an in-container child process when a command session is killed", async () => {
        const sentinel = "session-kill-survivor.txt"
        const handle = await env.spawnCommand(
          `sh -c 'sleep 1; echo late > ${sentinel}' & wait`,
          {
            cwd: workspace,
            tty: false,
          }
        )
        const exit = new Promise((resolve) => handle.onExit(resolve))

        handle.kill()
        await exit
        await delay(1_300)
        await expect(
          readFile(join(workspace, sentinel), "utf8")
        ).rejects.toThrow()
      })

      it("writes a file that appears on the host via the bind mount", async () => {
        const target = await env.resolve("probe.txt")
        await env.writeFile(target, "from-container")
        const onHost = await readFile(join(workspace, "probe.txt"), "utf8")
        expect(onHost).toBe("from-container")
      })

      it("rejects paths whose in-container realpath leaves the mount", async () => {
        await symlink("/tmp", join(workspace, "external-link"))

        await expect(env.resolve("external-link")).rejects.toThrow(
          "outside the workspace"
        )
      })

      it("rejects file tool access through symlinks outside the mount", async () => {
        const external = `/tmp/ns-027-${runtime}-${process.pid}`
        const link = `tool-escape-link-${runtime}`
        await env.exec(
          `rm -rf ${external} && mkdir -p ${external} && printf 'secret\\n' > ${external}/sentinel.txt`,
          {
            cwd: workspace,
            timeoutMs: 10_000,
            maxOutputBytes: 1024 * 1024,
          }
        )
        await symlink(external, join(workspace, link))

        const ctx = { workspace, env }
        const read = await readFileTool.execute(
          { path: `${link}/sentinel.txt` },
          ctx
        )
        expect(read).toContain("ERROR[not_allowed]")
        await expect(
          listFilesTool.execute({ path: link }, ctx)
        ).rejects.toThrow("outside the workspace")
        await expect(
          searchTool.execute({ path: link, query: "secret" }, ctx)
        ).rejects.toThrow("outside the workspace")
        await expect(
          writeFileTool.execute(
            { path: `${link}/created.txt`, content: "created" },
            ctx
          )
        ).rejects.toThrow("outside the workspace")
        await expect(
          editFileTool.execute(
            {
              path: `${link}/sentinel.txt`,
              old_string: "secret",
              new_string: "changed",
            },
            ctx
          )
        ).rejects.toThrow("outside the workspace")

        const patch = await applyPatchTool.execute(
          {
            operations: [
              {
                type: "update",
                path: `${link}/sentinel.txt`,
                hunks: [{ old_string: "secret", new_string: "changed" }],
              },
            ],
          },
          ctx
        )
        expect(patch).toContain("ERROR[invalid_patch]")
        expect(patch).toContain("outside the workspace")

        const check = await env.exec(
          `test "$(cat ${external}/sentinel.txt)" = secret && test ! -e ${external}/created.txt`,
          {
            cwd: workspace,
            timeoutMs: 10_000,
            maxOutputBytes: 1024 * 1024,
          }
        )
        expect(check.exitCode).toBe(0)
      })

      it("installs a file only when the destination is absent", async () => {
        const staged = await env.resolve("staged.txt")
        const created = await env.resolve("created.txt")

        await env.writeFile(staged, "staged")
        await env.installFileNoReplace(staged, created)

        expect(await readFile(join(workspace, "created.txt"), "utf8")).toBe(
          "staged"
        )
        expect(await readFile(join(workspace, "staged.txt"), "utf8")).toBe(
          "staged"
        )
      })

      it("does not replace an existing destination during no-replace install", async () => {
        const staged = await env.resolve("blocked-staged.txt")
        const created = await env.resolve("blocked-created.txt")

        await env.writeFile(staged, "staged")
        await env.writeFile(created, "external")

        await expect(
          env.installFileNoReplace(staged, created)
        ).rejects.toThrow()
        expect(
          await readFile(join(workspace, "blocked-created.txt"), "utf8")
        ).toBe("external")
        expect(
          await readFile(join(workspace, "blocked-staged.txt"), "utf8")
        ).toBe("staged")
      })

      it("cleans a patch temp file when a container write persists and then fails", async () => {
        const source = await env.resolve("patch-source.txt")
        await env.writeFile(source, "old\n")
        const writeThrough = env.writeFile.bind(env)
        env.writeFile = async (path, data) => {
          await writeThrough(path, data)
          if (path.includes(".north-star-")) {
            throw new Error("injected container write failure after persist")
          }
        }

        const result = await applyPatchTool.execute(
          {
            operations: [
              {
                type: "update",
                path: "patch-source.txt",
                hunks: [{ old_string: "old", new_string: "new" }],
              },
            ],
          },
          { workspace, env }
        )

        expect(result).toContain("ERROR[commit_failed]")
        expect(await env.readFile(source)).toEqual(Buffer.from("old\n"))
        expect(
          (await env.readdir(await env.resolve(""))).filter((entry) =>
            entry.name.includes(".north-star-")
          )
        ).toEqual([])
      })

      it("round-trips tricky utf8 content through the base64 pipe", async () => {
        const target = await env.resolve("tricky.txt")
        // Content the base64 pipe must carry intact: multibyte chars, a newline,
        // single quotes, and a tab — all of which would corrupt or break a naive
        // (un-encoded, shell-interpolated) write/read. writeFile's contract is utf8.
        const payload =
          "\u65e5\u672c\u8a9e \ud83d\ude80\nline2 'quoted'\twith tab\n"
        await env.writeFile(target, payload)
        const buf = await env.readFile(target)
        expect(buf.equals(Buffer.from(payload, "utf8"))).toBe(true)
        expect(buf.toString("utf8")).toBe(payload)
      })

      it("isolates writes outside the mount from the host", async () => {
        // Create + remove a file outside /workspace inside the container; the host
        // workspace is untouched (nothing leaks out of the mount).
        await env.exec("touch /tmp/inside-only && rm -f /tmp/inside-only", {
          cwd: workspace,
          timeoutMs: 10_000,
          maxOutputBytes: 1024 * 1024,
        })
        const hostEntries = await env.readdir(await env.resolve(""))
        expect(
          hostEntries.find((e) => e.name === "inside-only")
        ).toBeUndefined()
      })

      it("readdir distinguishes files and directories", async () => {
        await env.mkdirp(await env.resolve("adir"))
        await env.writeFile(await env.resolve("afile.txt"), "x")
        const entries = await env.readdir(await env.resolve(""))
        const byName = new Map(entries.map((e) => [e.name, e]))
        expect(byName.get("adir")!.isDirectory()).toBe(true)
        expect(byName.get("afile.txt")!.isFile()).toBe(true)
      })

      it("search finds a line via a single in-container command", async () => {
        await env.writeFile(
          await env.resolve("hay.txt"),
          "alpha\n84f2348602b2\ngamma"
        )
        const { matches, capped } = await env.search({
          root: await env.resolve(""),
          query: "84f2348602b2",
          mode: "fixed",
          case: "smart",
          globs: [],
          result: "content",
          beforeContext: 0,
          afterContext: 0,
          includeHidden: false,
          respectIgnore: true,
          maxFileBytes: 1024 * 1024,
          maxResults: 100,
        })
        expect(capped).toBe(false)
        expect(matches).toHaveLength(1)
        expect(matches[0].line).toBe(2)
        expect(matches[0].text).toBe("84f2348602b2")
        // Path comes back as an in-container path under the mount.
        expect(matches[0].path).toContain("hay.txt")
      })

      it("search prunes skipDirs and applies the glob filter", async () => {
        await env.mkdirp(await env.resolve("node_modules"))
        await env.writeFile(
          await env.resolve("node_modules/dep.ts"),
          "glob-marker-84f2348602b2"
        )
        await env.writeFile(
          await env.resolve("keep.ts"),
          "glob-marker-84f2348602b2"
        )
        await env.writeFile(
          await env.resolve("keep.md"),
          "glob-marker-84f2348602b2"
        )
        const { matches } = await env.search({
          root: await env.resolve(""),
          query: "glob-marker-84f2348602b2",
          mode: "fixed",
          case: "smart",
          result: "content",
          beforeContext: 0,
          afterContext: 0,
          includeHidden: false,
          respectIgnore: true,
          globs: ["*.ts", "!**/node_modules/**"],
          maxFileBytes: 1024 * 1024,
          maxResults: 100,
        })
        const names = matches.map((m) => m.path)
        expect(names.some((p) => p.endsWith("keep.ts"))).toBe(true)
        expect(names.some((p) => p.includes("node_modules"))).toBe(false)
        expect(names.some((p) => p.endsWith("keep.md"))).toBe(false)
      })

      it("reads bounded line windows inside the container", async () => {
        await env.writeFile(
          await env.resolve("page.txt"),
          "one\n日本語 café 🚀\nthree\nfour\n"
        )
        const first = await env.readTextLines(await env.resolve("page.txt"), {
          offset: 2,
          limit: 2,
          maxBytes: 256 * 1024,
        })
        const next = await env.readTextLines(await env.resolve("page.txt"), {
          offset: first.nextOffset!,
          limit: 2,
          maxBytes: 256 * 1024,
        })

        expect(first).toMatchObject({
          text: "日本語 café 🚀\nthree",
          startLine: 2,
          endLine: 3,
          hasMore: true,
          nextOffset: 4,
        })
        expect(first.text).not.toContain("�")
        expect(next).toMatchObject({
          text: "four",
          startLine: 4,
          endLine: 4,
          hasMore: false,
          truncated: false,
        })
      })

      it("advances past oversized lines inside the container", async () => {
        await env.writeFile(
          await env.resolve("long.txt"),
          `${"日本語".repeat(1000)}\nsecond`
        )
        const first = await env.readTextLines(await env.resolve("long.txt"), {
          offset: 1,
          limit: 10,
          maxBytes: 14,
        })
        const next = await env.readTextLines(await env.resolve("long.txt"), {
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
      })

      it("streams through oversized physical lines larger than the read chunk", async () => {
        await writeFile(
          join(workspace, "huge-line.txt"),
          `${"a".repeat(2 * 1024 * 1024)}\nsecond\n`,
          "utf8"
        )

        const first = await env.readTextLines(
          await env.resolve("huge-line.txt"),
          {
            offset: 1,
            limit: 10,
            maxBytes: 32,
          }
        )
        const next = await env.readTextLines(
          await env.resolve("huge-line.txt"),
          {
            offset: first.nextOffset!,
            limit: 10,
            maxBytes: 32,
          }
        )

        expect(first.text).toBe("a".repeat(32))
        expect(first).toMatchObject({
          startLine: 1,
          endLine: 1,
          hasMore: true,
          nextOffset: 2,
          truncated: true,
          lineTooLong: true,
          skippedLineRemainder: true,
        })
        expect(next).toMatchObject({
          text: "second",
          startLine: 2,
          endLine: 2,
          hasMore: false,
          truncated: false,
        })
      })
    }
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
