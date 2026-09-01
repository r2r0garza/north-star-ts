import { describe, expect, it } from "vitest"
import type { SkillMetadata } from "../skills/types"
import {
  agentCapabilitySummary,
  agentCapabilityPolicy,
  externalAgentToolFilter,
  resolvePolicyChildren,
  resolvePolicyMcpServers,
  resolvePolicySkills,
} from "./capability-policy"
import type { AgentDefinition, ExternalAgentSourceKind } from "./types"

function agent(
  sourceKind: ExternalAgentSourceKind,
  overrides: Partial<AgentDefinition> = {}
): AgentDefinition {
  const nativeName = overrides.nativeName ?? overrides.name ?? sourceKind
  const ref = {
    sourceKind,
    scope: "workspace" as const,
    definitionPath: `/repo/.${sourceKind}/agents/${nativeName}.md`,
    nativeName,
  }
  return {
    name: nativeName,
    nativeName,
    description: "agent",
    tools: undefined,
    skills: undefined,
    children: undefined,
    mcpServers: undefined,
    userInvocable: true,
    body: "",
    path: ref.definitionPath,
    source: "/repo",
    ref,
    refId: `agentref:v1:${JSON.stringify(ref)}`,
    sourceKind,
    scope: "workspace",
    label: `${sourceKind}: ${nativeName}`,
    diagnostics: [],
    ...overrides,
  }
}

function skill(name: string): SkillMetadata {
  return {
    name,
    description: name,
    path: `/skills/${name}/SKILL.md`,
    body: "",
    source: "/skills",
    metadata: {},
    allowedTools: [],
  }
}

describe("external agent capability policy", () => {
  it("does not apply the North Star read/search floor to explicit external empty tools", () => {
    const policy = agentCapabilityPolicy(agent("github", { tools: [] }))!
    const allow = externalAgentToolFilter(policy, false)!

    expect(allow("read_file_tool")).toBe(false)
    expect(allow("search_tool")).toBe(false)
    expect(allow("ask_user_question")).toBe(false)
  })

  it("maps GitHub groups and individual tools without broadening unsupported tools", () => {
    const policy = agentCapabilityPolicy(
      agent("github", {
        tools: ["read", "web/fetch", "vscodeGeneral/open"],
      })
    )!
    const allow = externalAgentToolFilter(policy, false)!

    expect(allow("read_file_tool")).toBe(true)
    expect(allow("list_files_tool")).toBe(true)
    expect(allow("web_fetch")).toBe(true)
    expect(allow("web_search")).toBe(false)
    expect(policy.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "unsupported_tool_group_member",
        message: expect.stringContaining("vscodeGeneral/open"),
      })
    )
  })

  it("adds GitHub ask_user_question only through the VS Code question grant", () => {
    const noQuestion = agentCapabilityPolicy(
      agent("github", { tools: ["read"] })
    )!
    const withQuestion = agentCapabilityPolicy(
      agent("github", { tools: ["vscode/askQuestions"] })
    )!

    expect(
      externalAgentToolFilter(noQuestion, false)!("ask_user_question")
    ).toBe(false)
    expect(
      externalAgentToolFilter(withQuestion, false)!("ask_user_question")
    ).toBe(true)
  })

  it("maps GitHub problem and run-test capabilities to narrow structured tools", () => {
    const policy = agentCapabilityPolicy(
      agent("github", {
        tools: ["read/problems", "execute/runTests", "execute/testFailure"],
      })
    )!
    const allow = externalAgentToolFilter(policy, false)!

    expect(allow("workspace_diagnostics")).toBe(true)
    expect(allow("run_tests")).toBe(true)
    expect(allow("get_test_results")).toBe(true)
    expect(allow("exec_command")).toBe(false)
  })

  it("maps GitHub filesystem lifecycle capabilities without broad edit or shell access", () => {
    const policy = agentCapabilityPolicy(
      agent("github", {
        tools: ["read", "edit/createDirectory", "vscodeGeneral/rename"],
      })
    )!
    const allow = externalAgentToolFilter(policy, false)!

    expect(allow("read_file_tool")).toBe(true)
    expect(allow("create_directory")).toBe(true)
    expect(allow("move_path")).toBe(true)
    expect(allow("write_file_tool")).toBe(false)
    expect(allow("exec_command")).toBe(false)
  })

  it("maps GitHub source-control capabilities to read-only Git tools only", () => {
    const policy = agentCapabilityPolicy(
      agent("github", {
        tools: ["read/sourceControl", "vscodeGeneral/git"],
      })
    )!
    const allow = externalAgentToolFilter(policy, false)!

    expect(allow("git_status")).toBe(true)
    expect(allow("git_diff")).toBe(true)
    expect(allow("git_log")).toBe(true)
    expect(allow("git_show")).toBe(true)
    expect(allow("git_branches")).toBe(true)
    expect(allow("exec_command")).toBe(false)
    expect(allow("write_file_tool")).toBe(false)
  })

  it("maps document and notebook read capabilities to read_document only", () => {
    const github = agentCapabilityPolicy(
      agent("github", {
        tools: ["read/readDocument", "notebook/read", "notebook/run"],
      })
    )!
    const claude = agentCapabilityPolicy(
      agent("claude", { tools: ["NotebookRead", "NotebookEdit"] })
    )!

    expect(externalAgentToolFilter(github, false)!("read_document")).toBe(true)
    expect(externalAgentToolFilter(github, false)!("exec_command")).toBe(false)
    expect(externalAgentToolFilter(github, false)!("write_file_tool")).toBe(
      false
    )
    expect(github.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "unsupported_tool_group_member",
        message: expect.stringContaining("notebook/run"),
      })
    )
    expect(externalAgentToolFilter(claude, false)!("read_document")).toBe(true)
    expect(externalAgentToolFilter(claude, false)!("exec_command")).toBe(false)
    expect(claude.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "unsupported_tool_group_member",
        message: expect.stringContaining("NotebookEdit"),
      })
    )
  })

  it("maps GitHub and Claude language-service capabilities to navigation tools", () => {
    const github = agentCapabilityPolicy(
      agent("github", {
        tools: ["vscodeGeneral/usages", "vscodeGeneral/definitions"],
      })
    )!
    const claude = agentCapabilityPolicy(agent("claude", { tools: ["LSP"] }))!

    expect(externalAgentToolFilter(github, false)!("find_references")).toBe(
      true
    )
    expect(externalAgentToolFilter(github, false)!("go_to_definition")).toBe(
      true
    )
    expect(externalAgentToolFilter(github, false)!("exec_command")).toBe(false)
    expect(externalAgentToolFilter(claude, false)!("hover_type")).toBe(true)
    expect(externalAgentToolFilter(claude, false)!("edit_file_tool")).toBe(
      false
    )
  })

  it("applies Claude allow and disallowedTools precedence", () => {
    const policy = agentCapabilityPolicy(
      agent("claude", {
        tools: ["Read", "Edit", "Skill(review)", "Agent(helper)"],
        sourceMetadata: { disallowedTools: ["Edit"] },
      })
    )!
    const allow = externalAgentToolFilter(policy, false)!

    expect(allow("read_file_tool")).toBe(true)
    expect(allow("edit_file_tool")).toBe(false)
    expect(allow("apply_patch_tool")).toBe(false)
    expect(allow("read_skill")).toBe(true)
    expect(allow("spawn_subagent")).toBe(true)
  })

  it("infers Claude compatibility for a verbatim agent imported into a North Star source", () => {
    const policy = agentCapabilityPolicy(
      agent("north_star", {
        tools: [
          "Read",
          "Write",
          "Edit",
          "Bash",
          "Grep",
          "Glob",
          "AskUserQuestion",
        ],
        sourceMetadata: {
          tools: "Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion",
        },
      })
    )!
    const allow = externalAgentToolFilter(policy, false)!

    expect(allow("read_file_tool")).toBe(true)
    expect(allow("list_files_tool")).toBe(true)
    expect(allow("write_file_tool")).toBe(true)
    expect(allow("edit_file_tool")).toBe(true)
    expect(allow("apply_patch_tool")).toBe(true)
    expect(allow("exec_command")).toBe(true)
    expect(allow("search_tool")).toBe(true)
    expect(allow("ask_user_question")).toBe(true)
    expect(policy.diagnostics).toContainEqual(
      expect.objectContaining({ code: "source_format_inferred" })
    )
  })

  it("keeps native North Star category agents on the native policy path", () => {
    expect(
      agentCapabilityPolicy(
        agent("north_star", { tools: ["read", "edit", "execute"] })
      )
    ).toBeNull()
  })

  it("honors a comma-separated Claude disallowedTools scalar after import", () => {
    const policy = agentCapabilityPolicy(
      agent("north_star", {
        tools: ["Read", "Edit", "Bash"],
        sourceMetadata: { disallowedTools: "Edit, Bash" },
      })
    )!
    const allow = externalAgentToolFilter(policy, false)!

    expect(allow("read_file_tool")).toBe(true)
    expect(allow("edit_file_tool")).toBe(false)
    expect(allow("apply_patch_tool")).toBe(false)
    expect(allow("exec_command")).toBe(false)
  })

  it("orients imported Claude instructions to North Star tools and AGENTS.md", () => {
    const imported = agent("north_star", { tools: ["Read", "Bash"] })
    const policy = agentCapabilityPolicy(imported)!
    const summary = agentCapabilitySummary(imported, policy, [
      "read_file_tool",
      "exec_command",
    ])!

    expect(summary).toContain("Tool names in the agent instructions")
    expect(summary).toContain("CLAUDE.md")
    expect(summary).toContain("AGENTS.md")
    expect(summary).toContain("must not fail the task")
  })

  it("filters Claude skills and same-provider named children", () => {
    const parent = agent("claude", {
      name: "parent",
      nativeName: "parent",
      tools: ["Skill(review)", "Agent(helper)"],
      skills: ["review", "debug"],
    })
    const policy = agentCapabilityPolicy(parent)!

    expect(
      resolvePolicySkills(
        parent,
        [skill("review"), skill("debug")],
        policy
      ).map((s) => s.name)
    ).toEqual(["review"])
    expect(
      resolvePolicyChildren(
        parent,
        [
          agent("claude", { name: "helper" }),
          agent("github", { name: "helper" }),
        ],
        policy
      ).map((child) => child.sourceKind)
    ).toEqual(["claude"])
  })

  it("removes mutation, execution, and spawning for Cursor readonly and Codex read-only", () => {
    for (const policy of [
      agentCapabilityPolicy(
        agent("cursor", { sourceMetadata: { readonly: true } })
      )!,
      agentCapabilityPolicy(
        agent("codex", { sourceMetadata: { sandbox_mode: "read-only" } })
      )!,
    ]) {
      const allow = externalAgentToolFilter(policy, false)!
      expect(allow("read_file_tool")).toBe(true)
      expect(allow("write_file_tool")).toBe(false)
      expect(allow("exec_command")).toBe(false)
      expect(allow("spawn_subagent")).toBe(false)
    }
  })

  it("intersects named external MCP servers with enabled North Star servers", () => {
    const policy = agentCapabilityPolicy(
      agent("github", { mcpServers: ["known", "missing"] })
    )!

    expect(
      resolvePolicyMcpServers(agent("github"), ["known", "other"], policy)
    ).toEqual(["known"])
  })
})
