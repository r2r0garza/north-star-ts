import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { HostFileError, openHostFile } from "./host_files"
import { readFileTool } from "./read_file_tool"
import { readDocumentTool } from "./document_extraction_tool"

const posix = process.platform !== "win32"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "host-files-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(HostFileError)
  expect((error as HostFileError).code).toBe(code)
  return error as HostFileError
}

describe("openHostFile", () => {
  it("opens a regular attachment and derives size from the handle", async () => {
    const file = join(dir, "a.txt")
    await writeFile(file, "hello")
    const opened = await openHostFile(file, "attachment")
    try {
      expect(opened.size).toBe(5)
    } finally {
      await opened.handle.close()
    }
  })

  it("maps a missing file to not_found without leaking the host path", async () => {
    const missing = join(dir, "missing.txt")
    const error = await expectCode(
      openHostFile(missing, "attachment"),
      "not_found"
    )
    expect(error.message).not.toContain(dir)
  })

  it("rejects a directory", async () => {
    await expectCode(openHostFile(dir, "attachment"), "not_a_file")
  })

  it.runIf(posix)(
    "refuses an attachment that was swapped for a symlink",
    async () => {
      const secret = join(dir, "secret.txt")
      const attached = join(dir, "attached.txt")
      await writeFile(secret, "top secret")
      await symlink(secret, attached)
      const error = await expectCode(
        openHostFile(attached, "attachment"),
        "not_a_file"
      )
      expect(error.message).not.toContain(dir)
    }
  )

  it.runIf(posix)("refuses a dangling attachment symlink", async () => {
    const attached = join(dir, "dangling.txt")
    await symlink(join(dir, "nowhere"), attached)
    await expectCode(openHostFile(attached, "attachment"), "not_a_file")
  })

  it.runIf(posix)("rejects a FIFO instead of blocking on open", async () => {
    const fifo = join(dir, "pipe")
    execFileSync("mkfifo", [fifo])
    await expectCode(openHostFile(fifo, "attachment"), "not_a_file")
  })

  it.runIf(posix)(
    "still opens a symlinked skill resource path (trusted origin)",
    async () => {
      const real = join(dir, "real.txt")
      const link = join(dir, "link.txt")
      await writeFile(real, "ok")
      await symlink(real, link)
      const opened = await openHostFile(link, "skill_resource")
      try {
        expect(opened.size).toBe(2)
      } finally {
        await opened.handle.close()
      }
    }
  )
})

describe.runIf(posix)("attachment reads through the tools", () => {
  it("read_file_tool refuses an attachment replaced by a symlink", async () => {
    const secret = join(dir, "secret.txt")
    const attached = join(dir, "attached.txt")
    await writeFile(attached, "original")
    await writeFile(secret, "top secret")
    const ctx = { workspace: "", attachments: [attached] }

    expect(await readFileTool.execute({ path: attached }, ctx)).toContain(
      "original"
    )

    await rm(attached)
    await symlink(secret, attached)
    const result = await readFileTool.execute({ path: attached }, ctx)
    expect(result).toContain("ERROR[not_a_file]")
    expect(result).not.toContain("top secret")
  })

  it("read_document refuses an attachment replaced by a symlink", async () => {
    const target = join(dir, "real.ipynb")
    const attached = join(dir, "attached.ipynb")
    const notebook = JSON.stringify({
      nbformat: 4,
      cells: [{ cell_type: "markdown", source: ["top secret"] }],
    })
    await writeFile(target, notebook)
    await symlink(target, attached)

    const result = await readDocumentTool.execute(
      { path: attached },
      { workspace: "", attachments: [attached] }
    )
    expect(result).toContain("ERROR[not_a_file]")
    expect(result).not.toContain("top secret")
  })

  it("read_file_tool still reads skill resources", async () => {
    const skillRoot = join(dir, "skill")
    await mkdir(skillRoot)
    await writeFile(join(skillRoot, "ref.txt"), "skill body\n")
    const result = await readFileTool.execute(
      { path: "skill://demo/ref.txt" },
      { workspace: dir, skillResourceRoots: { demo: skillRoot } }
    )
    expect(result).toContain("skill body")
  })
})
