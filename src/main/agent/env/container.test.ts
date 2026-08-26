import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtemp, rm, readFile, writeFile } from "fs/promises"
import { hostname, tmpdir } from "os"
import { join } from "path"
import { ContainerEnvironment } from "./container"
import { checkContainerTestAvailability } from "./container-test-availability"

const IMAGE = process.env.COWORK_ENV_IMAGE || "node:20-bookworm"

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

      it("writes a file that appears on the host via the bind mount", async () => {
        const target = await env.resolve("probe.txt")
        await env.writeFile(target, "from-container")
        const onHost = await readFile(join(workspace, "probe.txt"), "utf8")
        expect(onHost).toBe("from-container")
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
