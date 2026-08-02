import { describe, it, expect } from "vitest"
import { changedFilesFromCalls, type ToolUse } from "./timeline"

// Build a minimal ToolUse; only name + args.path matter to the derivation.
function call(name: string, path?: string, id = path ?? name): ToolUse {
  return {
    id,
    name,
    label: name,
    args: path ? { path } : {},
    rawArgs: JSON.stringify(path ? { path } : {}),
    status: "done",
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
})
