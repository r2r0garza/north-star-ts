import { afterEach, beforeEach, expect, it } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { LocalEnvironment } from "../env/local"
import { resolveReadable } from "./host_files"
import { readFileTool } from "./read_file_tool"
import { readDocumentTool } from "./document_extraction_tool"

let root: string
let workspace: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "workspace-attachments-"))
  workspace = join(root, "workspace")
  await mkdir(workspace)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it("reads an explicit external attachment while retaining workspace confinement", async () => {
  const attached = join(root, "notes.txt")
  await writeFile(attached, "attached text")
  await writeFile(join(workspace, "notes.txt"), "workspace text")
  const ctx = { workspace, attachments: [attached] }
  expect(await readFileTool.execute({ path: attached }, ctx)).toContain(
    "attached text"
  )
  expect(await readFileTool.execute({ path: "notes.txt" }, ctx)).toContain(
    "workspace text"
  )
  expect(
    await readFileTool.execute({ path: join(root, "secret.txt") }, ctx)
  ).toContain("not_allowed")
})

it("resolves attached screenshots outside the workspace through the host reader", async () => {
  const image = join(root, "screenshot.png")
  await writeFile(
    image,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
      "base64"
    )
  )
  const ctx = { workspace, attachments: [image] }
  expect(
    await resolveReadable(ctx, new LocalEnvironment(workspace), image)
  ).toEqual({ source: "host", origin: "attachment", path: image })
  const output = await readDocumentTool.execute({ path: image }, ctx)
  expect(output).not.toContain("not_allowed")
})

it("rejects ambiguous attachment names but accepts exact paths", async () => {
  const a = join(root, "a", "notes.txt")
  const b = join(root, "b", "notes.txt")
  const ctx = { workspace: "", attachments: [a, b] }
  const env = new LocalEnvironment(workspace)
  await expect(resolveReadable(ctx, env, "notes.txt")).rejects.toThrow(
    "multiple attachments"
  )
  expect(await resolveReadable(ctx, env, b)).toEqual({
    source: "host",
    origin: "attachment",
    path: b,
  })
})
