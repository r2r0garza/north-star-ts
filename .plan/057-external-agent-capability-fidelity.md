# PR57: External agent capability fidelity and compatibility diagnostics

> Status: **NOT STARTED**. Depends on `056`'s source-specific parsers and stable
> references. This is the enforcement boundary: an external definition may narrow
> North Star's runtime, but can never widen it.

## Context

North Star currently maps friendly native categories to internal tool names and adds a
read/search floor plus universal tools. That contract is valid for existing North Star
agents, but it cannot faithfully represent GitHub's hierarchical groups and individual
VS Code tools, Claude's allow/deny and parameterized `Skill(...)`/`Agent(...)` rules,
Cursor's `readonly`, or Codex's sandbox posture.

Using the current category parser for external files can overgrant. Examples:

- An individual `web/fetch` grant must not imply every web capability.
- An unavailable `vscodeGeneral/rename` must not become the entire edit category.
- A write-only agent must not receive read/search merely because North Star normally
  considers those tools a floor.
- `tools: []` must not regain infrastructure tools through the native universal set.

The agreed policy is conservative and runnable: unknown/unavailable source tools are
denied individually, the agent continues with the capabilities that map exactly, and a
compatibility warning explains every dropped capability.

## Goal

1. Normalize every source's permission language into a source-neutral capability IR.
2. Intersect that IR with the tools actually available in the current North Star mode,
   workspace, environment, and plan state.
3. Never add a read/search floor or native universal capabilities to external agents.
4. Apply the agreed source-specific `ask_user_question` policy.
5. Enforce skill, child-agent, and MCP restrictions without name-collision ambiguity.
6. Produce structured compatibility diagnostics visible before and during execution.

## Enforcement invariant

For an external agent:

```text
effective tools = runtime/mode offered tools
                  ∩ source-authorized North Star equivalents
                  − source denials
                  − headless/background suppressions
```

No adapter may manufacture authority absent from the source. A broad source group may
expand only to the documented North Star equivalents registered for that group. An
individual source tool maps only to exact or safely narrower equivalents. If no safe
mapping exists, deny it and emit `unsupported_tool`; never guess a broader category.

The existing North Star parser/category behavior remains backward compatible for
`sourceKind === "north_star"`, including its current tri-state and universal/floor
contract. External agents use the new IR and do not pass through
`agentToolAllowlist()`.

## Capability IR

```ts
interface AgentCapabilityPolicy {
  builtins: "all" | Set<NorthStarToolName>
  deniedBuiltins: Set<NorthStarToolName>
  askUserQuestion: "allow" | "deny" | "suppress_when_headless"
  skills: SkillPolicy
  children: ChildAgentPolicy
  mcp: McpPolicy
  diagnostics: AgentCompatibilityDiagnostic[]
}
```

Keep source rule provenance on each grant/denial so the UI can say, for example,
"`vscodeGeneral/rename` has no safe North Star equivalent" rather than only "some
tools are missing." The effective policy is immutable for a model round and the
existing exact offered-tool guard remains the final dispatch backstop.

## GitHub/Copilot mapping

Support group expansion for the agreed group vocabulary:

- `agent` -> North Star subagent spawning.
- `browser` -> all currently offered North Star browser operations.
- `edit` -> file edit/write/patch equivalents; notebook/rename-only operations are
  not invented when only an individual operation was requested.
- `execute` -> command-session execution/control equivalents.
- `read` -> file/list equivalents plus only specifically safe read surfaces.
- `search` -> text/file/index search equivalents.
- `todo` -> North Star todo capabilities available in the current mode.
- `vscode` -> only North Star equivalents explicitly registered for VS Code
  capabilities; importantly, it includes `ask_user_question` because the group
  contains `vscode/askQuestions`.
- `web` -> North Star web fetch/search equivalents.

Create an exhaustive, table-driven registry for every individual tool identifier in
the planning input. Representative exact mappings:

- `read/readFile` -> `read_file_tool`
- `search/textSearch` -> `search_tool`
- `web/fetch` -> `web_fetch`
- `vscode/askQuestions` -> `ask_user_question`
- browser navigation/click/type/screenshot/read operations -> the closest exact
  browser operation(s)
- `execute/runInTerminal` -> command-session execution
- `edit/createFile` -> `write_file_tool`
- `edit/editFiles` -> edit/patch equivalents

Identifiers without a safe equivalent (`vscode/extensions`, notebook operations,
`vscodeGeneral/rename`, terminal-selection-only APIs, etc.) remain denied with one
diagnostic per source rule. Group grants do not suppress diagnostics for unavailable
members; aggregate them in the UI to avoid warning spam.

Omitted `tools` means all **mode-appropriate North Star equivalents** for GitHub's
available tool universe, not tools North Star does not possess. Explicit tools mean
only the expanded/mapped set. Respect `user-invocable` in discovery (`056`).

## Claude mapping

Parse and normalize Claude rules before offering tools:

- `tools` omitted -> all otherwise available North Star equivalents.
- `tools: []` -> no tools.
- `disallowedTools` subtracts after allow expansion; omission/empty means no denial.
- `Read` -> read file/list equivalents.
- `Write` -> write-file equivalent.
- `Edit` -> edit/patch equivalents.
- `Grep`/`Glob` -> search equivalents.
- `Bash`/`PowerShell` -> command-session equivalents.
- `WebFetch`/`WebSearch` -> corresponding web tools.
- `Agent`/`Agent(a, b)` -> child policy below.
- `Skill`/`Skill(name)`/`Skill(name *)` -> skill policy below.
- `TodoWrite` and compatible Task tools -> only existing North Star todo/background
  equivalents.
- `LSP`, notebook, monitor, Artifact, worktree-mode, and other unavailable tools are
  denied with diagnostics unless/until North Star gains an exact implementation.

Claude `skills:` preloads the named North Star skills at agent startup; it is not by
itself a permission allowlist. Skill invocation is controlled by the `Skill` tool
rules:

- `Skill` -> any discoverable skill.
- `Skill(name)` -> exact name, no arguments beyond the invocation itself.
- `Skill(name *)` -> prefix/argument form for that skill.
- no `Skill` in an explicit tool list -> no runtime skill invocation.

If a preloaded/allowed skill is not installed in North Star, continue without it and
emit a missing-skill diagnostic. Skill `allowed-tools` may grant temporary authority
only to the extent `007`/the North Star skill runtime explicitly supports that
contract; it must not bypass this agent policy by accident.

Claude child rules:

- `tools` omitted includes `Agent` and permits any loadable child.
- unqualified `Agent` permits any loadable child.
- `Agent(a, b)` permits only names `a` and `b`.
- no `Agent` in an explicit tool list means no spawning.

Resolve a named child within the declaring source/scope first, then that provider's
documented global/workspace precedence. Never satisfy `Agent(reviewer)` with a GitHub
or North Star `reviewer` merely because the Claude definition is missing.

## Cursor mapping

- Cursor has no Markdown tool allowlist in the agreed source surface, so omitted
  restrictions map to all mode-appropriate North Star tools.
- `readonly: true` removes file mutation and execution tools wholesale. This is
  intentionally conservative: North Star cannot currently prove that an arbitrary
  shell command is read-only before offering the shell tool.
- `readonly: false`/omitted does not bypass North Star workspace confinement,
  approvals, mode restrictions, or plan mode.
- Cursor agents cannot receive `spawn_subagent` in North Star in any conversation
  mode. Their source format has no child allowlist that North Star can honor, so a
  general/default tool grant does not include spawning.
- A Process may still select a Cursor agent as a phase worker. That is Process-engine
  orchestration, not the Cursor worker spawning a child, and does not grant the worker
  `spawn_subagent`.

## Codex mapping

- `sandbox_mode = "read-only"` removes mutation and execution tools.
- `workspace-write` permits normal mode-appropriate tools inside North Star's own
  workspace and approval policy.
- `danger-full-access` can never widen North Star confinement or approval rules; it
  means only "no additional narrowing from this source field" and produces a notice
  that North Star's safety boundary still applies.
- Codex agent configs do not currently provide source-style fine-grained built-in
  tool rules, so otherwise use all mode-appropriate North Star tools.
- Codex agents cannot receive `spawn_subagent` in North Star in any conversation mode.
  Current Codex agent configs do not express a per-agent child allowlist that North
  Star can honor. Codex multi-agent defaults/limits are not treated as permission to
  spawn arbitrary North Star agents.
- A Process may still select a Codex agent as a phase worker. Process assignment does
  not grant that worker child-spawning authority.

## `ask_user_question` policy

Apply after source normalization and before each model round:

- North Star: preserve current universal behavior.
- Cursor running inside North Star: add for interactive foreground runs.
- Claude running inside North Star: add for interactive foreground runs.
- GitHub/Copilot: add only when `vscode` or `vscode/askQuestions` grants it.
- Codex running inside North Star: add for interactive foreground runs unless a
  future supported config field explicitly disables it.
- Background agents and all headless Process phase/decompose/validate workers:
  suppress regardless of source.

This plan does not change Claude Code CLI behavior. If a future adapter runs a Claude
agent natively, North Star does not inject its question tool; Claude runs with its own
configured tools.

## MCP policy

- Named external MCP servers map only to enabled North Star MCP servers with the same
  configured identity/name.
- Missing named servers do not auto-install or auto-launch. Deny their tools, show
  "MCP setup required," and link to North Star's MCP settings.
- Claude inline `mcpServers` definitions are parsed and displayed but never executed
  automatically. The user must explicitly create/review the server in North Star;
  secrets and arbitrary commands are not copied silently.
- GitHub/Copilot `mcp-servers` receives the same treatment.
- Once configured, server tool access remains the intersection of the agent's source
  rules and North Star's enabled server/tool catalog.
- Native CLI execution is outside this plan: a future Claude `--agent` path relies on
  the user's Claude MCP configuration rather than North Star's MCP manager.

## Compatibility diagnostics

Structured codes should include at least:

- `unsupported_tool`
- `unsupported_tool_group_member`
- `missing_skill`
- `missing_child_agent`
- `missing_mcp_server`
- `inline_mcp_requires_setup`
- `source_restriction_narrowed`
- `runtime_mode_withheld_tool`

The Agents view shows full diagnostics. Pickers show a warning badge/summary without
becoming unusable. The activity/transcript records the effective capability summary at
run start so later debugging is evidence-based even if the file changes.

## Verification

- Table-driven tests cover every GitHub tool/group identifier supplied in the plan,
  including group expansion and individual non-broadening.
- Claude allow/deny precedence, empty-vs-omitted lists, parameterized Skill/Agent
  rules, missing names, and same-name cross-provider isolation.
- Cursor and Codex never receive `spawn_subagent`, including in Chat, Interactive,
  North Star, and Process worker runs; Process assignment itself remains supported.
- Cursor/Codex read-only policies offer no edit/write/patch/command tool.
- A deliberately write-only external agent receives no read/search floor.
- Unknown tools are absent from the offered set, produce diagnostics, and do not stop
  other mapped tools from running.
- Ask-user-question matrix across five sources, interactive/background, and Process
  headless execution.
- Named/inline/missing MCP server cases fail closed without launching an unreviewed
  process.
- Existing North Star agent tests stay green with their current floor/universal
  semantics.
- Exact dispatch guard rejects any model-fabricated or stale withheld tool name.

## Out of scope

- Source discovery, identity, and persistence migration (`056`).
- Model alias resolution, background scheduling, max turns, hooks, memory, isolation,
  effort, and initial prompt execution (`058`).
- Implementing unavailable VS Code/Claude/Codex tools merely to eliminate warnings.
- Native `claude --agent`/Codex CLI agent invocation.
