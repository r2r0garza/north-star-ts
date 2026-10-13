import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { resolveFileLink, saveFileLink } from "./save-link"

const { getPath, getConversation, workingDirectoryOf, chatScratchDir } =
  vi.hoisted(() => ({
    getPath: vi.fn(),
    getConversation: vi.fn(),
    workingDirectoryOf: vi.fn(),
    chatScratchDir: vi.fn(),
  }))
vi.mock("electron", () => ({ app: { getPath } }))
vi.mock("../db/repositories/conversations", () => ({ getConversation }))
vi.mock("../db/repositories/workspaces", () => ({ workingDirectoryOf }))
vi.mock("../agent/tools/chat_shell", () => ({ chatScratchDir }))
let dir: string
let workspace: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "save-link-"))
  workspace = join(dir, "workspace")
  await mkdir(workspace)
  await writeFile(join(workspace, "preguntas revisión.md"), "# Preguntas\n")
  vi.clearAllMocks()
  getPath.mockReturnValue(join(dir, "Downloads"))
  getConversation.mockReturnValue({ id: "conv-1" })
  workingDirectoryOf.mockReturnValue(workspace)
  chatScratchDir.mockReturnValue(workspace)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

it("resolves encoded relative, absolute and file URLs", async () => {
  const file = await resolveFileLink(workspace, "preguntas%20revisi%C3%B3n.md")
  expect(await resolveFileLink(workspace, file)).toBe(file)
  expect(await resolveFileLink(workspace, pathToFileURL(file).href)).toBe(file)
})
it("rejects traversal, symlink escapes, directories and unsupported schemes", async () => {
  await writeFile(join(dir, "outside.md"), "outside")
  await symlink(join(dir, "outside.md"), join(workspace, "escape.md"))
  for (const href of [
    "../outside.md",
    "escape.md",
    ".",
    "https://example.com/file",
    "javascript:alert(1)",
    "sandbox:/mnt/data/missing.md",
  ]) {
    await expect(resolveFileLink(workspace, href)).rejects.toThrow()
  }
})
it.each(["chat", "interactive", "north-star"])(
  "downloads %s files to the OS Downloads directory",
  async (mode) => {
    if (mode === "chat") workingDirectoryOf.mockReturnValue(undefined)
    const destination = await saveFileLink(
      "conv-1",
      "preguntas%20revisi%C3%B3n.md"
    )
    expect(getPath).toHaveBeenCalledWith("downloads")
    expect(destination).toBe(join(dir, "Downloads", "preguntas revisión.md"))
    expect(await readFile(destination, "utf8")).toBe("# Preguntas\n")
    if (mode === "chat") expect(chatScratchDir).toHaveBeenCalledWith("conv-1")
  }
)
it("never overwrites existing downloads, including simultaneous clicks", async () => {
  await mkdir(join(dir, "Downloads"))
  await writeFile(join(dir, "Downloads", "preguntas revisión.md"), "existing")
  const destinations = await Promise.all([
    saveFileLink("conv-1", "preguntas%20revisi%C3%B3n.md"),
    saveFileLink("conv-1", "preguntas%20revisi%C3%B3n.md"),
  ])
  expect(new Set(destinations)).toEqual(
    new Set([
      join(dir, "Downloads", "preguntas revisión (1).md"),
      join(dir, "Downloads", "preguntas revisión (2).md"),
    ])
  )
  expect(
    await readFile(join(dir, "Downloads", "preguntas revisión.md"), "utf8")
  ).toBe("existing")
})
it("rejects invalid or deleted conversations before looking up files", async () => {
  await expect(saveFileLink("../escape", "file.md")).rejects.toThrow(
    "Invalid conversation"
  )
  getConversation.mockReturnValue(undefined)
  await expect(saveFileLink("deleted", "file.md")).rejects.toThrow(
    "no longer available"
  )
  expect(getPath).not.toHaveBeenCalled()
})
