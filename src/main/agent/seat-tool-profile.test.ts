import { describe, it, expect } from "vitest"
import { allowedForSeatProfile } from "./seat-tool-profile"

// Plan 106.4 decision 4: a turn woken by mail can read and search, never
// mutate, execute, delegate, or reach outside the app.
describe("allowedForSeatProfile", () => {
  const mutating = [
    "write_file_tool",
    "edit_file_tool",
    "apply_patch_tool",
    "exec_command",
    "delete_path",
    "spawn_subagent",
    "record_proof",
    "flag_for_rework",
    "todo_write",
    "web_fetch",
    "web_search",
    "mcp__github__create_issue",
  ]
  const reading = ["read_file_tool", "search_tool", "list_files_tool", "git_diff"]

  it("keeps everything for a playbook step", () => {
    for (const name of [...mutating, ...reading])
      expect(allowedForSeatProfile(name, "work")).toBe(true)
  })

  it("keeps only local read-only tools for a wake", () => {
    for (const profile of ["consult", "answer_only"] as const) {
      for (const name of mutating)
        expect([profile, name, allowedForSeatProfile(name, profile)]).toEqual([
          profile,
          name,
          false,
        ])
      for (const name of reading)
        expect(allowedForSeatProfile(name, profile)).toBe(true)
      expect(allowedForSeatProfile("read_skill", profile, new Set(["read_skill"]))).toBe(true)
    }
  })

  it("offers messaging to consult wakes but not to answer-only ones", () => {
    for (const name of ["send_message", "reply", "list_inbox", "escalate"]) {
      expect(allowedForSeatProfile(name, "consult")).toBe(true)
      expect(allowedForSeatProfile(name, "answer_only")).toBe(false)
    }
  })
})
