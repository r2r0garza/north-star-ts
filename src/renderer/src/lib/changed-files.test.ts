import { describe, it, expect } from "vitest"
import {
  changedFilesFromCalls,
  deriveLabel,
  toToolUse,
  type ToolStatus,
  type ToolUse,
} from "./timeline"

// Build a minimal ToolUse; only name + args.path matter to the derivation.
function call(
  name: string,
  path?: string,
  id = path ?? name,
  status: ToolStatus = "done",
  result = "ok"
): ToolUse {
  return {
    id,
    name,
    label: name,
    args: path ? { path } : {},
    rawArgs: JSON.stringify(path ? { path } : {}),
    result,
    status,
  }
}

describe("changedFilesFromCalls", () => {
  it("returns only edit/write tool calls", () => {
    const files = changedFilesFromCalls([
      call("read_file_tool", "src/a.ts"),
      call("edit_file_tool", "src/b.ts"),
      call("write_file_tool", "src/c.ts"),
      call("search_tool"),
    ])
    expect(files.map((f) => f.path)).toEqual(["src/b.ts", "src/c.ts"])
  })

  it("tags kind by tool", () => {
    const files = changedFilesFromCalls([
      call("edit_file_tool", "e.ts"),
      call("write_file_tool", "w.ts"),
    ])
    expect(files.find((f) => f.path === "e.ts")?.kind).toBe("edit")
    expect(files.find((f) => f.path === "w.ts")?.kind).toBe("write")
  })

  it("dedupes by path (last write wins, keeps position)", () => {
    const files = changedFilesFromCalls([
      call("write_file_tool", "page.tsx", "1"),
      call("read_file_tool", "other.ts", "2"),
      call("edit_file_tool", "page.tsx", "3"),
    ])
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe("page.tsx")
    // Last write was an edit, so kind reflects it.
    expect(files[0].kind).toBe("edit")
  })

  it("classifies html vs code by extension", () => {
    const files = changedFilesFromCalls([
      call("write_file_tool", "index.html"),
      call("write_file_tool", "app/page.HTM"),
      call("edit_file_tool", "src/main.ts"),
    ])
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.fileType]))
    expect(byPath["index.html"]).toBe("html")
    expect(byPath["app/page.HTM"]).toBe("html")
    expect(byPath["src/main.ts"]).toBe("code")
  })

  it("sets baseName from the path", () => {
    const [f] = changedFilesFromCalls([
      call("edit_file_tool", "src/components/login.tsx"),
    ])
    expect(f.baseName).toBe("login.tsx")
  })

  it("skips calls with no path arg", () => {
    expect(changedFilesFromCalls([call("write_file_tool")])).toEqual([])
  })

  it("only includes completed successful mutation calls", () => {
    const files = changedFilesFromCalls([
      call("write_file_tool", "ok.ts", "1"),
      call("write_file_tool", "bad.ts", "2", "error", "ERROR[bad_args]: nope"),
      call("edit_file_tool", "running.ts", "3", "running", undefined),
      call("edit_file_tool", "interrupted.ts", "4", "interrupted", undefined),
      call(
        "edit_file_tool",
        "also-bad.ts",
        "5",
        "done",
        "ERROR[stale_file]: nope"
      ),
    ])

    expect(files.map((f) => f.path)).toEqual(["ok.ts"])
  })

  it("includes successful apply_patch add/update/move operations", () => {
    const files = changedFilesFromCalls([
      {
        id: "patch-1",
        name: "apply_patch_tool",
        label: "Applied patch",
        args: {
          operations: [
            { type: "add", path: "new.html" },
            { type: "update", path: "src/existing.ts" },
            { type: "move", path: "old.ts", new_path: "src/moved.ts" },
            { type: "delete", path: "gone.ts" },
          ],
        },
        rawArgs: "",
        result: "Applied patch: added 1, updated 1, moved 1, deleted 1.",
        status: "done",
      },
    ])

    expect(files.map((f) => [f.path, f.kind, f.fileType])).toEqual([
      ["new.html", "write", "html"],
      ["src/existing.ts", "edit", "code"],
      ["src/moved.ts", "edit", "code"],
    ])
  })

  it("excludes failed apply_patch operations", () => {
    const files = changedFilesFromCalls([
      {
        id: "patch-1",
        name: "apply_patch_tool",
        label: "Patch failed",
        args: { operations: [{ type: "add", path: "new.html" }] },
        rawArgs: "",
        result: "ERROR[already_exists]: new.html already exists",
        status: "error",
      },
    ])

    expect(files).toEqual([])
  })

  it("updates write labels by mutation status", () => {
    const args = { path: "financial-dashboard.html" }

    expect(deriveLabel("write_file_tool", args, "running")).toBe(
      "Writing financial-dashboard.html"
    )
    expect(deriveLabel("write_file_tool", args, "done")).toBe(
      "Wrote financial-dashboard.html"
    )
    expect(deriveLabel("write_file_tool", args, "error")).toBe(
      "Write failed financial-dashboard.html"
    )
    expect(deriveLabel("write_file_tool", args, "interrupted")).toBe(
      "Write interrupted financial-dashboard.html"
    )
  })

  it("starts live write rows with a running label", () => {
    const use = toToolUse({
      id: "call-1",
      name: "write_file_tool",
      arguments: JSON.stringify({ path: "index.html" }),
    })

    expect(use.label).toBe("Writing index.html")
    expect(use.status).toBe("running")
  })

  it("updates patch labels by mutation status", () => {
    expect(deriveLabel("apply_patch_tool", {}, "running")).toBe(
      "Applying patch"
    )
    expect(deriveLabel("apply_patch_tool", {}, "done")).toBe("Applied patch")
    expect(deriveLabel("apply_patch_tool", {}, "error")).toBe("Patch failed")
    expect(deriveLabel("apply_patch_tool", {}, "interrupted")).toBe(
      "Patch interrupted"
    )
  })
})
