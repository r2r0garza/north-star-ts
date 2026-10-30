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

// summarySection reads the rolling-summary repo. Mock it so the section is
// exercised without a DB (the repo itself is covered by
// conversation-summaries.test.ts).
let summary: ConversationSummary | undefined
vi.mock("../../db/repositories/conversation-summaries", () => ({
  getConversationSummary: () => summary,
}))

// environmentSection reads the git branch and resolves a model label. Mock both
// so the section is exercised without a real repo, DB, or provider config.
// `gitBranch` is the readGitBranch result.
let gitBranch: unknown = null
vi.mock("../../index/metadata", () => ({
  readGitBranch: () => Promise.resolve(gitBranch),
}))

let modelLabel: string | null = null
vi.mock("../providers", () => ({
  resolveModelLabel: () => modelLabel,
}))

import {
  taskStateSection,
  approvalsSection,
  summarySection,
  environmentSection,
  browserStateSection,
} from "./sections"
import { SECTION_PRIORITY } from "./context-builder"
import type { ConversationSummary } from "../../db/types"

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
  over: Partial<ActionAllowlistRule> &
    Pick<ActionAllowlistRule, "kind" | "identity" | "scope">
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

function approval(
  over: Partial<Approval> & Pick<Approval, "status">
): Approval {
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
    rules = [
      rule({ kind: "shell", identity: "git status", scope: "workspace" }),
    ]
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
    const occurrences =
      section!.content.split("shell ls [workspace]").length - 1
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

function summaryRecord(
  over: Partial<ConversationSummary> = {}
): ConversationSummary {
  return {
    conversationId: "c1",
    summary: "## Decisions\n- use sqlite",
    coversThrough: 20,
    messageCount: 20,
    tokenEstimate: 30,
    updatedAt: 0,
    ...over,
  }
}

describe("summarySection", () => {
  it("returns null when no summary exists", () => {
    summary = undefined
    expect(summarySection("c1")).toBeNull()
  })

  it("returns null when the summary is blank", () => {
    summary = summaryRecord({ summary: "   " })
    expect(summarySection("c1")).toBeNull()
  })

  it("renders the digest at the summary priority (highest, dropped last)", () => {
    summary = summaryRecord({ summary: "## Decisions\n- use sqlite" })
    const section = summarySection("c1")
    expect(section).not.toBeNull()
    expect(section!.name).toBe("summary")
    expect(section!.priority).toBe(SECTION_PRIORITY.summary)
    expect(section!.priority).toBeGreaterThan(SECTION_PRIORITY.skills)
    expect(section!.content).toContain("use sqlite")
    expect(section!.content).toContain("Conversation summary so far")
    expect(section!.replacesHistoryThrough).toBe(summary!.coversThrough)
    expect(section!.provenance).toEqual({
      trust: "untrusted_data",
      channel: "memory",
      source: "conversation_summary",
      persisted: true,
    })
  })
})

describe("browserStateSection", () => {
  it("states 'nothing open' (never null) when no page is live", () => {
    const section = browserStateSection(null)
    expect(section.name).toBe("browser_state")
    expect(section.priority).toBe(SECTION_PRIORITY.browserState)
    expect(section.content).toContain("No page is currently open")
    expect(section.content).toContain("authoritative current state")
    // No stale URL should leak into a nothing-open section.
    expect(section.content).not.toContain("http")
    expect(section.provenance).toMatchObject({
      trust: "system",
      channel: "runtime",
    })
  })

  it("names the current page when a tab is open", () => {
    const section = browserStateSection({
      url: "https://www.google.com/search?q=deepagents+docs",
      title: "deepagents docs - Google Search",
      loading: false,
    })
    expect(section.priority).toBe(SECTION_PRIORITY.browserState)
    expect(section.content).toContain(
      "Current page: https://www.google.com/search?q=deepagents+docs"
    )
    expect(section.content).toContain("Title: deepagents docs - Google Search")
    expect(section.content).not.toContain("still loading")
  })

  it("marks a still-loading page and omits a title equal to the URL", () => {
    const section = browserStateSection({
      url: "https://example.com",
      title: "https://example.com",
      loading: true,
    })
    expect(section.content).not.toContain("Title:")
    expect(section.content).toContain("still loading")
  })
})

describe("environmentSection", () => {
  const fixedNow = new Date(2026, 6, 30) // deterministic date line

  it("includes date + model but no workspace/platform/git in bare chat", async () => {
    gitBranch = { path: ".git/HEAD", value: { branch: "main" } } // ignored: no ws
    modelLabel = "Claude Opus"
    const section = await environmentSection({
      llmSelection: { accountId: null, modelId: null },
      now: fixedNow,
    })
    expect(section).not.toBeNull()
    expect(section!.name).toBe("environment")
    expect(section!.priority).toBe(SECTION_PRIORITY.environment)
    expect(section!.content).toContain("Model: Claude Opus")
    expect(section!.content).toContain("Date:")
    expect(section!.content).not.toContain("Time:")
    expect(section!.content).not.toContain("Workspace:")
    expect(section!.content).not.toContain("Platform:")
    expect(section!.content).not.toContain("Git")
    expect(section!.provenance).toMatchObject({
      trust: "system",
      channel: "runtime",
    })
  })

  it("omits the model line when no model resolves", async () => {
    gitBranch = null
    modelLabel = null
    const section = await environmentSection({ now: fixedNow })
    expect(section!.content).not.toContain("Model:")
  })

  it("adds workspace + platform but NO git block for a non-repo folder", async () => {
    gitBranch = null // readGitBranch returns null → not a repo
    modelLabel = "m"
    const section = await environmentSection({
      workspacePath: "/ws",
      now: fixedNow,
    })
    expect(section!.content).toContain("Workspace: /ws")
    expect(section!.content).toContain("Platform:")
    expect(section!.content).not.toContain("Git branch")
  })

  it("shows only the branch for a repo: no status or commits that churn the cache", async () => {
    gitBranch = { path: ".git/HEAD", value: { branch: "feat/x" } }
    modelLabel = "m"
    const section = await environmentSection({
      workspacePath: "/ws",
      now: fixedNow,
    })
    expect(section!.content).toContain("Git branch: feat/x")
    expect(section!.content).not.toContain("Git status")
    expect(section!.content).not.toContain("Recent commits")
  })

  it("shows a detached HEAD by short sha", async () => {
    gitBranch = {
      path: ".git/HEAD",
      value: { detached: true, sha: "deadbeef1234" },
    }
    modelLabel = "m"
    const section = await environmentSection({
      workspacePath: "/ws",
      now: fixedNow,
    })
    expect(section!.content).toContain("detached at deadbeef1234")
  })
})
