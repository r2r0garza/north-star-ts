import { constants } from "fs"
import { lstat, open, type FileHandle } from "fs/promises"
import { basename } from "path"
import type { Environment } from "../env/types"
import type { ToolContext } from "./types"
import { isSkillResourceUri, resolveSkillResourcePath } from "./skill_resources"

// Where a readable file lives. Workspace files go through the env (host or
// container). Host files are read directly and come in two distinct flavours:
//  - "attachment": a user-attached file at an arbitrary absolute host path. The
//    path is user-controlled, so its final component must never be a symlink.
//  - "skill_resource": an already-resolved, symlink-free path under an activated
//    skill root (see resolveSkillResourcePath). Trusted; opened without the
//    no-follow flag so packaged layouts are not tightened by accident.
export type Readable =
  | { source: "env"; path: string }
  | { source: "host"; origin: HostOrigin; path: string }

export type HostOrigin = "attachment" | "skill_resource"

// Resolve the model-supplied `path` to a safe location. With a workspace it must
// resolve inside it (symlinks included), via the env. Without one (Chat sessions),
// the only readable files are the user's attachments, so `path` must match one of
// them — by exact absolute path or by file name — and is read from the host (the
// env is irrelevant: a container is only ever used when a workspace exists).
export async function resolveReadable(
  ctx: ToolContext,
  env: Environment,
  path: string
): Promise<Readable> {
  if (isSkillResourceUri(path)) {
    return {
      source: "host",
      origin: "skill_resource",
      path: await resolveSkillResourcePath(ctx, path),
    }
  }
  if (ctx.workspace) {
    return { source: "env", path: await env.resolve(path) }
  }
  const attachments = ctx.attachments ?? []
  const match = attachments.find((a) => a === path || basename(a) === path)
  if (!match) {
    throw new Error(
      `"${path}" is not an attached file. Readable files: ${
        attachments.map((a) => basename(a)).join(", ") || "(none)"
      }.`
    )
  }
  return { source: "host", origin: "attachment", path: match }
}

export type HostFileErrorCode = "not_found" | "not_a_file" | "read_failed"

// Bounded, path-free error: callers already know which model-supplied path they
// asked for, so the message never carries an underlying host path.
export class HostFileError extends Error {
  constructor(
    readonly code: HostFileErrorCode,
    message: string
  ) {
    super(message)
    this.name = "HostFileError"
  }
}

export interface OpenedHostFile {
  handle: FileHandle
  // Size of the file the handle actually refers to, not of a path looked up
  // earlier.
  size: number
}

// O_NOFOLLOW is undefined on Windows, where it is a no-op flag value of 0.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0
// A FIFO opened for reading blocks until a writer appears; open non-blocking so
// the handle check below can reject it instead.
const O_NONBLOCK = constants.O_NONBLOCK ?? 0

// Opens a host file and validates the *opened handle*, closing the stat-then-open
// window in which a path could be swapped for a symlink or special file.
//  - attachments: opened with O_NOFOLLOW. Where the platform lacks it, the path
//    is lstat'ed first and the handle's identity compared against that lstat.
//  - skill resources: opened normally (the path is pre-resolved and trusted).
// Either way the handle must be a regular file, and `size` comes from the handle.
export async function openHostFile(
  path: string,
  origin: HostOrigin
): Promise<OpenedHostFile> {
  const noFollow = origin === "attachment"
  let expected: { dev: bigint; ino: bigint } | undefined
  if (noFollow && O_NOFOLLOW === 0) {
    try {
      const pre = await lstat(path, { bigint: true })
      if (pre.isSymbolicLink()) {
        throw new HostFileError("not_a_file", "Attachment is a symbolic link.")
      }
      expected = { dev: pre.dev, ino: pre.ino }
    } catch (error) {
      throw mapOpenError(error)
    }
  }

  let handle: FileHandle
  try {
    handle = await open(
      path,
      constants.O_RDONLY | O_NONBLOCK | (noFollow ? O_NOFOLLOW : 0)
    )
  } catch (error) {
    throw mapOpenError(error)
  }

  try {
    const info = await handle.stat({ bigint: true })
    if (!info.isFile()) {
      throw new HostFileError("not_a_file", "Not a regular file.")
    }
    // Only meaningful where inode numbers are real (Windows can report 0).
    if (
      expected &&
      expected.ino !== 0n &&
      (info.ino !== expected.ino || info.dev !== expected.dev)
    ) {
      throw new HostFileError("not_a_file", "File changed while opening.")
    }
    return { handle, size: Number(info.size) }
  } catch (error) {
    await handle.close().catch(() => {})
    throw error instanceof HostFileError
      ? error
      : new HostFileError("read_failed", "Could not inspect the file.")
  }
}

function mapOpenError(error: unknown): HostFileError {
  if (error instanceof HostFileError) return error
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new HostFileError("not_found", "No such file.")
  }
  // O_NOFOLLOW on a symlink: ELOOP on Linux/macOS, EMLINK on FreeBSD.
  if (code === "ELOOP" || code === "EMLINK") {
    return new HostFileError("not_a_file", "Attachment is a symbolic link.")
  }
  if (code === "EISDIR") {
    return new HostFileError("not_a_file", "Not a regular file.")
  }
  return new HostFileError("read_failed", "Could not open the file.")
}
