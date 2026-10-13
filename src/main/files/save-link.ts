import { app } from "electron"
import { constants } from "node:fs"
import { copyFile, mkdir, realpath, stat } from "node:fs/promises"
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"
import { chatScratchDir } from "../agent/tools/chat_shell"
import { getConversation } from "../db/repositories/conversations"
import { workingDirectoryOf } from "../db/repositories/workspaces"
import { fileURLToPath } from "node:url"
import { localFileLink } from "../../shared/file-link"

export async function resolveFileLink(
  workspace: string,
  href: string
): Promise<string> {
  const link = localFileLink(href)
  if (!link || !workspace)
    throw new Error("This link does not identify a conversation file.")
  const root = await realpath(workspace)
  const path = /^file:/i.test(link)
    ? fileURLToPath(link)
    : decodeURIComponent(link)
  const source = await realpath(resolve(root, path))
  const rel = relative(root, source)
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("This file is outside the conversation's file folder.")
  }
  if (!(await stat(source)).isFile())
    throw new Error("This link does not point to a file.")
  return source
}

export async function saveFileLink(
  conversationId: string,
  href: string
): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(conversationId)) {
    throw new Error("Invalid conversation for file download.")
  }
  const conversation = getConversation(conversationId)
  if (!conversation)
    throw new Error("This conversation is no longer available.")
  const root =
    workingDirectoryOf(conversation) ?? chatScratchDir(conversationId)
  const source = await resolveFileLink(root, href)
  const downloads = app.getPath("downloads")
  await mkdir(downloads, { recursive: true })
  const name = basename(source)
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length)
  for (let index = 0; ; index++) {
    const destination = join(
      downloads,
      index === 0 ? name : `${stem} (${index})${extension}`
    )
    try {
      await copyFile(source, destination, constants.COPYFILE_EXCL)
      return destination
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
  }
}
