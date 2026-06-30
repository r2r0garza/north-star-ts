import { dirname, join } from "path"
import type { Tool } from "./types"
import type { ToolAction } from "../approval/types"
import { LocalEnvironment } from "../env/local"
import type { Environment } from "../env/types"
import { toolError } from "./output"

// Atomic write: temp file in the same directory, then rename over the target.
// Both steps go through the env so the atomicity holds on host or in a container.
async function atomicWrite(
  env: Environment,
  target: string,
  content: string
): Promise<void> {
  const tmp = join(dirname(target), `.${Date.now()}-${process.pid}.tmp`)
  await env.writeFile(tmp, content)
  await env.rename(tmp, target)
}

// Creates, overwrites, or appends to a file inside the workspace, creating
// parent directories as needed. Writes atomically and returns a short
// confirmation rather than echoing the content back (which would bloat the
// context window). The `append` mode lets a large file be built across several
// calls so no single call carries the whole blob as one oversized JSON argument
// (which can be truncated at the model's output-token cap and fail to parse).
export const writeFileTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "write_file_tool",
      description:
        "Write a file inside the workspace. mode \"create\" (default) creates or " +
        "overwrites the file with `content`. mode \"append\" adds `content` to the " +
        "end of the file (creating it if absent). Parent directories are created " +
        "automatically. Prefer edit_file_tool to modify an existing file. Use " +
        "create for small new files; for a large generated file, write it in " +
        "chunks — one create call, then repeated append calls — which avoids " +
        "truncating a huge single argument.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file, relative to the workspace root.",
          },
          content: {
            type: "string",
            description: "The file content to write (the full file for create, or the chunk for append).",
          },
          mode: {
            type: "string",
            enum: ["create", "append"],
            description:
              'How to write. "create" (default) creates or overwrites the file. ' +
              '"append" reads the existing file and appends content to the end ' +
              "(creating it if missing). Use append to build a large file across " +
              "multiple calls — keep each call's content to a manageable chunk.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  execute: async (args, ctx) => {
    const path = typeof args.path === "string" ? args.path : ""
    if (!path) return toolError("bad_args", "A `path` is required.")
    if (typeof args.content !== "string") {
      return toolError("bad_args", "`content` must be a string.")
    }
    const content = args.content
    const mode = args.mode === undefined ? "create" : args.mode
    if (mode !== "create" && mode !== "append") {
      return toolError("bad_args", '`mode` must be "create" or "append".')
    }

    const env = ctx.env ?? new LocalEnvironment(ctx.workspace)
    const target = await env.resolve(path)

    // Route through the shared approval pipeline (see ../approval). The default
    // file policy auto-allows, so behavior is unchanged today — but this makes
    // write_file a first-class pipeline participant, so gating file writes later
    // is a one-line classifier change, not an architectural one. The identity is
    // the target path alone (not mode/chunk) on purpose: a multi-chunk append
    // write reuses one identity, so a single allowlist approval covers it all
    // rather than re-prompting for every chunk.
    if (ctx.gate) {
      const action: ToolAction = {
        tool: "write_file_tool",
        kind: "file_write",
        summary: `write ${path}`,
        identity: `file_write:${path}`,
        detail: { path },
      }
      const outcome = await ctx.gate(action)
      if (outcome === "blocked") {
        return toolError("blocked", `Writing ${path} is blocked by policy.`)
      }
      if (outcome === "denied") {
        return toolError("denied", `The user denied approval to write ${path}.`)
      }
    }

    await env.mkdirp(dirname(target))

    // Append re-reads the current file and rewrites the whole concatenation
    // through atomicWrite, so atomicity holds with no Environment change. A read
    // failure means the file doesn't exist yet — append-to-missing is a create,
    // not an error.
    let finalContent = content
    if (mode === "append") {
      let existing = ""
      try {
        existing = (await env.readFile(target)).toString("utf8")
      } catch {
        existing = ""
      }
      finalContent = existing + content
    }
    await atomicWrite(env, target, finalContent)

    const bytes = Buffer.byteLength(content, "utf8")
    return mode === "append"
      ? `Appended ${bytes} bytes to ${path}.`
      : `Wrote ${bytes} bytes to ${path}.`
  },
}
