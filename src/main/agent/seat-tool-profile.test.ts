import { describe, it, expect } from "vitest"
import { allowedForSeatProfile } from "./seat-tool-profile"
import { seatBrowserToolDefinitions } from "./tools"

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
  const reading = [
    "read_file_tool",
    "search_tool",
    "list_files_tool",
    "git_diff",
  ]

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
      expect(
        allowedForSeatProfile("read_skill", profile, new Set(["read_skill"]))
      ).toBe(true)
    }
  })

  it("offers messaging to consult wakes but not to answer-only ones", () => {
    for (const name of ["send_message", "reply", "list_inbox", "escalate"]) {
      expect(allowedForSeatProfile(name, "consult")).toBe(true)
      expect(allowedForSeatProfile(name, "answer_only")).toBe(false)
    }
  })

  // Plan 106.6: a Navigator direction wakes the lead to act on the plan.
  it("offers map tools to work and consult turns but not to answer-only ones", () => {
    for (const name of [
      "map_status",
      "assign_user_story",
      "revise_plan",
      "propose_plan",
    ]) {
      expect(allowedForSeatProfile(name, "work")).toBe(true)
      expect(allowedForSeatProfile(name, "consult")).toBe(true)
      expect(allowedForSeatProfile(name, "answer_only")).toBe(false)
    }
  })

  // Plan 109.04: a seat's work step drives the app in its browser; a wake
  // never gets it (the browser tools are open-world), and no seat gets
  // browser_handoff, since nobody is waiting to take over.
  it("offers seat browser tools to work turns only, without handoff", () => {
    const names = seatBrowserToolDefinitions.map((d) => d.function.name)
    expect(names).toContain("browser_navigate")
    expect(names).toContain("browser_screenshot")
    expect(names).not.toContain("browser_handoff")
    for (const name of names) {
      expect(allowedForSeatProfile(name, "work")).toBe(true)
      expect(allowedForSeatProfile(name, "consult")).toBe(false)
      expect(allowedForSeatProfile(name, "answer_only")).toBe(false)
    }
  })
})
