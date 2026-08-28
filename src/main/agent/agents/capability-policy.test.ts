import { describe, expect, it } from "vitest"
import type { SkillMetadata } from "../skills/types"
import {
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
        tools: ["read", "web/fetch", "vscodeGeneral/rename"],
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
        message: expect.stringContaining("vscodeGeneral/rename"),
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
