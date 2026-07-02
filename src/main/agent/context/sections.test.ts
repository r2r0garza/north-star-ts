import { describe, it, expect, vi } from "vitest"
import type {
  Task,
  TaskStatus,
  ActionAllowlistRule,
  Approval,
} from "../../db/types"

let tasks: Task[] = []
vi.mock("../../db/repositories/tasks", () => ({
  listTasks: (opts?: { sourceConversationId?: string }) =>
    tasks.filter(
      (t) =>
        !opts?.sourceConversationId ||
        t.sourceConversationId === opts.sourceConversationId
    ),
}))

// approvalsSection reads these two repos. Mock them like tasks so the section is
// exercised without a DB; the scope-resolution logic itself is covered by
// action-allowlist.test.ts (listRules).
let rules: ActionAllowlistRule[] = []
const listRulesCalls: Array<{
  workspacePath?: string | null
  conversationId?: string | null
}> = []
vi.mock("../../db/repositories/action-allowlist", () => ({
  listRules: (opts: {
    workspacePath?: string | null
    conversationId?: string | null
  }) => {
    listRulesCalls.push(opts)
    return rules
  },
}))

let approvals: Approval[] = []
vi.mock("../../db/repositories/approvals", () => ({
  listApprovals: (opts?: { taskId?: string }) =>
    approvals.filter((a) => !opts?.taskId || a.taskId === opts.taskId),
}))

import { taskStateSection, approvalsSection } from "./sections"
import { SECTION_PRIORITY } from "./context-builder"

function task(title: string, status: TaskStatus): Task {
  return {
    id: title,
    conversationId: "worker",
    sourceConversationId: "c1",
    title,
    status,
    input: null,
    result: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe("taskStateSection", () => {
  it("returns null when there are no active tasks", () => {
    tasks = [task("done", "completed"), task("nope", "cancelled")]
    expect(taskStateSection("c1")).toBeNull()
  })

  it("lists active tasks with their status", () => {
    tasks = [
      task("Indexing", "running"),
      task("Refactor", "paused"),
      task("old", "completed"),
    ]
    const section = taskStateSection("c1")
    expect(section).not.toBeNull()
    expect(section!.priority).toBe(SECTION_PRIORITY.taskState)
    expect(section!.content).toContain("Indexing — running")
    expect(section!.content).toContain("Refactor — paused")
    expect(section!.content).not.toContain("old")
  })

  it("only counts tasks sourced from this conversation", () => {
    tasks = [
      { ...task("mine", "running") },
      { ...task("theirs", "running"), sourceConversationId: "other" },
    ]
    const section = taskStateSection("c1")
    expect(section!.content).toContain("mine")
    expect(section!.content).not.toContain("theirs")
  })
})

function rule(
  over: Partial<ActionAllowlistRule> & Pick<ActionAllowlistRule, "kind" | "identity" | "scope">
): ActionAllowlistRule {
  return {
    id: `${over.kind}:${over.identity}:${over.scope}`,
    tool: "run_shell",
    workspacePath: null,
    conversationId: null,
    agentId: null,
    createdAt: 0,
    lastUsedAt: null,
    ...over,
  }
}

function approval(over: Partial<Approval> & Pick<Approval, "status">): Approval {
  return {
    id: over.status + Math.random().toString(36).slice(2),
    taskId: "t1",
    request: null,
    decision: null,
    requestedAt: 0,
    resolvedAt: null,
    ...over,
  }
}

describe("approvalsSection", () => {
  it("returns null when there are no rules and no task", () => {
    rules = []
    approvals = []
    expect(
      approvalsSection({ conversationId: "c1", workspacePath: "/ws" })
    ).toBeNull()
  })

  it("renders an already-allowed line for an in-scope rule", () => {
    rules = [rule({ kind: "shell", identity: "git status", scope: "workspace" })]
    approvals = []
    const section = approvalsSection({
      conversationId: "c1",
      workspacePath: "/ws",
    })
    expect(section).not.toBeNull()
    expect(section!.priority).toBe(SECTION_PRIORITY.approvals)
    expect(section!.content).toContain("already been granted")
    expect(section!.content).toContain("shell git status [workspace]")
  })

  it("passes workspace + conversation scope to listRules", () => {
    rules = []
    approvals = []
    listRulesCalls.length = 0
    approvalsSection({ conversationId: "c1", workspacePath: "/ws" })
    expect(listRulesCalls[0]).toEqual({
      workspacePath: "/ws",
      conversationId: "c1",
    })
  })

  it("dedups rules by (kind, identity, scope)", () => {
    rules = [
      rule({ kind: "shell", identity: "ls", scope: "workspace" }),
      rule({ kind: "shell", identity: "ls", scope: "workspace" }),
    ]
    approvals = []
    const section = approvalsSection({
      conversationId: "c1",
      workspacePath: "/ws",
    })
    const occurrences = section!.content.split("shell ls [workspace]").length - 1
    expect(occurrences).toBe(1)
  })

  it("omits the task half without a taskId, includes it with one", () => {
    rules = []
    approvals = [
      approval({ status: "approved", request: { summary: "run tests" } }),
    ]
    expect(
      approvalsSection({ conversationId: "c1", workspacePath: "/ws" })
    ).toBeNull()

    const section = approvalsSection({
      conversationId: "c1",
      workspacePath: "/ws",
      taskId: "t1",
    })
    expect(section!.content).toContain("approved: run tests")
  })

  it("shows a pending decision as awaiting, not granted", () => {
    rules = []
    approvals = [
      approval({ status: "pending", request: { summary: "delete file" } }),
    ]
    const section = approvalsSection({
      conversationId: "c1",
      taskId: "t1",
    })
    expect(section!.content).toContain("NOT yet granted")
    expect(section!.content).toContain("delete file")
  })
})
