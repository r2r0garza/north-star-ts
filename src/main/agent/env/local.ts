import { spawn } from "child_process"
import { readFile, writeFile, rename, mkdir, stat, readdir } from "fs/promises"
import { join } from "path"
import {
  resolveInWorkspace,
  resolveInWorkspaceReal,
} from "../tools/workspace"
import { captureSpawn } from "./spawn-util"
import type {
  Environment,
  ExecResult,
  ExecOptions,
  DirEntry,
  StatInfo,
  SearchOptions,
  SearchResult,
  SearchMatch,
} from "./types"

// The default backend: runs commands and file ops directly on the host, confined
// to `workspace`. A behavior-preserving wrapper over exactly what the tools did
// before this seam existed — fs/promises, child_process.spawn, and the workspace
// path resolvers — so existing tool tests pass unchanged.
export class LocalEnvironment implements Environment {
  constructor(private readonly workspace: string) {}

  resolve(path: string): Promise<string> {
    return resolveInWorkspaceReal(this.workspace, path)
  }

  resolveLexical(path: string): string {
    return resolveInWorkspace(this.workspace, path)
  }

  readFile(path: string): Promise<Buffer> {
    return readFile(path)
  }

  writeFile(path: string, data: string): Promise<void> {
    return writeFile(path, data, "utf8")
  }

  rename(from: string, to: string): Promise<void> {
    return rename(from, to)
  }

  async mkdirp(path: string): Promise<void> {
    await mkdir(path, { recursive: true })
  }

  stat(path: string): Promise<StatInfo> {
    return stat(path)
  }

  readdir(path: string): Promise<DirEntry[]> {
    return readdir(path, { withFileTypes: true })
  }

  // Run `command` through the user's shell, confined to `opts.cwd`. The capture/
  // cap/timeout/abort logic lives in captureSpawn (shared with the container
  // backend); this just spawns the process. stdin is closed so the command can't
  // block waiting for input.
  //
  // `detached: true` makes the child its own process-group leader, so on abort or
  // timeout captureSpawn can SIGKILL the whole group (killGroup) — otherwise a
  // `shell: true` command that forked children (a pipeline, `npm run build` → node)
  // would orphan them when only the sh wrapper is killed. We keep stdio piped (the
  // parent holds the handles) and deliberately do NOT call child.unref(): the child
  // stays tied to this turn, not surviving it.
  exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    return captureSpawn(child, { ...opts, killGroup: true })
  }

  // The original tool-side walk, moved behind the interface: recurse with readdir,
  // skip pruned dirs and the glob-mismatched/oversized/binary files, and regex
  // each line. In-process fs calls, so this stays as fast as before on the host.
  async search(opts: SearchOptions): Promise<SearchResult> {
    const regex = new RegExp(opts.pattern)
    const skip = new Set(opts.skipDirs)
    const matches: SearchMatch[] = []
    let capped = false

    const walk = async (dir: string): Promise<void> => {
      if (capped) return
      let entries: DirEntry[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return // unreadable dir — skip rather than fail the whole search
      }
      for (const entry of entries) {
        if (capped) return
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (skip.has(entry.name)) continue
          await walk(full)
          continue
        }
        if (!entry.isFile()) continue
        if (opts.glob && !entry.name.toLowerCase().includes(opts.glob)) continue
        try {
          const info = await stat(full)
          if (info.size > opts.maxFileBytes) continue
          const buf = await readFile(full)
          if (buf.subarray(0, 8000).includes(0)) continue // binary
          const lines = buf.toString("utf8").split("\n")
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              matches.push({ path: full, line: i + 1, text: lines[i].trim() })
              if (matches.length >= opts.maxResults) {
                capped = true
                return
              }
            }
          }
        } catch {
          // Unreadable file — skip.
        }
      }
    }

    await walk(opts.root)
    return { matches, capped }
  }

  async dispose(): Promise<void> {
    // Nothing to clean up on the host.
  }
}
