# Implemented Agent Tools

The tools the Cowork agent can call, as currently wired in `src/main/agent/`.
Update this file whenever a tool is added, removed, renamed, or its offering rules
change.

- **Registry and dispatch:** `src/main/agent/tools/index.ts`
- **Per-turn offering rules:** `buildTools` in `src/main/agent/index.ts`
- **Tool schemas and behavior:** `src/main/agent/tools/`
- **Per-chat skill reader:** `src/main/agent/skills/tool.ts`
- **External MCP tools:** discovered per turn by `src/main/agent/mcp/`

A tool being registered does not necessarily mean it is offered on every turn.
Workspace availability, conversation mode, plan mode, settings, the selected
agent's policy, and runtime capabilities can all narrow the model-facing toolset.

## Modes

Three conversation modes influence which tools are offered:

- **Chat** — no workspace confinement; the user can attach files. Tool-light.
- **Interactive** — workspace-backed, collaborative, and incremental.
- **North Star** — workspace-backed and intended for autonomous, end-to-end work.

## Workspace tools

These tools are offered when the turn has a workspace, subject to plan mode and
custom-agent restrictions.

| Tool | What it does | Important gating / notes |
| --- | --- | --- |
| `list_files_tool` | Lists files and directories. | Workspace-confined. |
| `read_file_tool` | Reads UTF-8 text with line numbers and paging. | Workspace-confined. In Chat, it can instead be offered for attached text files only. |
| `search_tool` | Searches workspace contents with fixed-string or regex matching, globs, context, and result modes. | Workspace-confined. |
| `edit_file_tool` | Replaces an exact string in an existing file. | Workspace-confined; mutation policy applies. |
| `write_file_tool` | Creates, overwrites, or appends to a file. | Workspace-confined; mutation policy applies. |
| `apply_patch_tool` | Applies a validated, atomic multi-file add/update/move/delete patch. | Workspace-confined; mutation policy applies. |
| `exec_command` | Runs foreground or background shell commands with bounded output and session support. | Workspace-confined; routes through shell policy and the approval gate. Uses the selected execution backend. |
| `write_stdin` | Writes text/control input to a running command session. | Session must belong to the current conversation/workspace. |
| `poll_command` | Reads bounded output and status from a command session. | Session must belong to the current conversation/workspace. |
| `wait_for_events` | Waits for owned background-command completion events. | Intended after independent work is exhausted, rather than timer-based polling. |
| `terminate_command` | Interrupts and then terminates a running command session. | Session must belong to the current conversation/workspace. |
| `workspace_diagnostics` | Runs the configured typecheck, lint, check, diagnostics, or semantic checker. | Uses declared workspace configuration rather than an arbitrary command. |
| `run_tests` | Runs a declared test target, with optional path/name filters. | Long-running tests return a result session. |
| `get_test_results` | Pages normalized test results and bounded raw evidence. | Requires a session created by `run_tests`. |
| `workspace_symbols` | Finds TypeScript/JavaScript symbols across the workspace. | Semantic navigation; read-only. |
| `document_symbols` | Lists symbols declared in a TypeScript/JavaScript document. | Semantic navigation; read-only. |
| `go_to_definition` | Resolves a TypeScript/JavaScript definition at a source position. | Semantic navigation; read-only. |
| `find_references` | Finds TypeScript/JavaScript references at a source position. | Semantic navigation; read-only. |
| `hover_type` | Returns TypeScript/JavaScript quick-info/type text. | Semantic navigation; read-only. |
| `stat_path` | Reads workspace-confined path metadata without following a final symlink. | Read-only. |
| `create_directory` | Creates a directory, optionally including parents. | Workspace-confined; mutation policy applies. |
| `move_path` | Moves or renames a path. | Workspace-confined; mutation policy applies. |
| `delete_path` | Deletes a file or directory. | Recursive directory deletion requires approval. |
| `git_status` | Reads structured Git working-tree status. | Read-only. |
| `git_diff` | Reads a bounded Git diff. | Read-only. |
| `git_log` | Reads recent commits. | Read-only. |
| `git_show` | Reads bounded content from a revision. | Read-only. |
| `git_branches` | Reads local branch information. | Read-only. |
| `read_document` | Extracts content from PDF, DOCX, XLSX, PPTX, IPYNB, and basic images. | Workspace-confined, or scoped to supported Chat attachments. Supports paging and document-specific filters; image-only PDF pages can be sent to a vision-capable model. |

Plan mode withholds the direct file-edit/patch and command-control surfaces and
also hard-blocks workspace mutations at the approval layer. Read-only workspace
tools remain available.

## Conversation, planning, and orchestration tools

These tools are registered centrally but offered according to conversation state
rather than simply the presence of a workspace.

| Tool | What it does | Offered when |
| --- | --- | --- |
| `todo_write` | Manages the conversation's durable task list. | Interactive and North Star modes. |
| `run_todos_in_background` | Hands the actionable todo list to the durable task runner. | Interactive and North Star modes outside plan mode; delegation requires explicit approval. |
| `ask_user_question` | Presents 1–4 structured clarification questions and pauses for answers. | Every mode except headless workers that cannot receive an answer. |
| `index_query_tool` | Queries the workspace index for symbols, importers, files, or metadata. | Workspace-backed non-Chat turns when “use index for context” is enabled. |
| `write_plan` | Writes or replaces the conversation's plan document. | Plan mode; also selectively available to planning subagents. |
| `read_plan` | Reads the conversation's plan document. | Interactive and North Star modes, both during planning and implementation. |
| `present_plan` | Presents the plan for approval and can transition the same turn out of plan mode. | Plan mode. |
| `spawn_subagent` | Runs one permitted named child agent synchronously. | Outside plan mode when the selected custom agent's child/tool policy allows it. Kept as the compatibility single-child surface. |
| `spawn_subagents` | Runs 1–4 named or ephemeral subagents concurrently. | Outside plan mode when delegation is enabled and depth/policy checks pass. Write-capable children require isolated writer worktrees. |
| `flag_for_rework` | Sends a defect back to an upstream Process phase. | Process phase workers only. |
| `dashboard_write` | Creates or replaces saved live dashboards from already-fetched data and refresh recipes. | Interactive and North Star modes outside plan mode, subject to agent policy. |
| `read_skill` | Loads the full instructions for one of the skills advertised in the prompt. | Every mode when skills are loaded; built per chat from the available skill set. |

### Conversation recall: implemented but not currently offered

`conversation_search`, `conversation_read`, and `conversation_tree_search` are
implemented, tested, registered, and dispatchable. They search the current
conversation or its descendant worker tree, not arbitrary unrelated past
conversations. They are mapped to custom-agent tool categories, but the normal
`buildTools` path does not currently add their definitions to model-facing
turns. Until that offering gap is closed, they should not be treated as an
available end-user agent capability.

## Web tools

| Tool | What it does | Important gating / notes |
| --- | --- | --- |
| `web_search` | Searches the web through the configured search provider and returns ranked results. | Offered in every mode, including plan mode. Read-only from the user's machine and not approval-gated. |
| `web_fetch` | Fetches an HTTP(S) page and extracts readable text/Markdown. | Offered in every mode except plan mode. Arbitrary-origin access routes through the approval gate and SSRF-oriented safe-fetch checks. |

## Browser use — implemented

Browser use is implemented through a visible, conversation-owned browser. These
tools are offered when the caller provides an agent-browser handle, independent
of whether the turn has a workspace:

- Navigation and inspection: `browser_navigate`, `browser_snapshot`,
  `browser_screenshot`, `browser_back`, and `browser_close`
- Interaction: `browser_click`, `browser_hover`, `browser_drag`, `browser_type`,
  and `browser_select_option`
- Waiting and diagnostics: `browser_wait`, `browser_console`, and
  `browser_network`
- Human/browser coordination: `browser_handle_dialog` and `browser_handoff`
- Advanced page-world evaluation: `browser_evaluate`

Navigation and advanced evaluation have their own approval rules. Browser tools
are also exposed through an explicit MCP allowlist to supported external CLI
providers when a browser handle is available.

## Computer use — not implemented

General computer use is **not implemented**. The agent cannot control arbitrary
desktop applications, the operating-system UI, the mouse or keyboard outside
its owned browser, or the user's screen as a general-purpose computer-use
surface. Browser use must not be described as computer use.

## External MCP tools

An MCP client is implemented. Enabled servers are resolved per turn, their tool
definitions are namespaced as `mcp__<server>__<tool>`, and calls are routed
through the pooled MCP manager. HTTP MCP servers can use OAuth with encrypted
token/client-registration persistence. Server and agent policy can narrow which
MCP tools are offered, and MCP tools are withheld in plan mode.

There is no built-in OSV/malware scanner for MCP packages or servers at this
time.

## Compatibility-only tools

- `run_shell_tool` remains dispatchable for old/internal callers but is not
  model-offered. New turns use `exec_command` and the command-session tools.

## Foundational mechanisms

### Execution environments — implemented

Workspace filesystem and process operations go through the `Environment`
interface in `src/main/agent/env/types.ts`. Implemented backends are:

- **Local** — with `host-access`, `workspace-write`, and `read-only` profiles
- **Container** — Docker or Podman, with the workspace mounted into the selected
  runtime

The backend is selected from persisted settings, with environment-variable
fallbacks for development. An unavailable configured backend fails visibly; it
is not silently replaced with another backend.

### Approval and safety policy

Dangerous actions build a `ToolAction` and route through the shared
`PolicyEngine` in `src/main/agent/approval/`. Decisions are allow, require
approval, require explicit approval, or hard block. Remembered grants can be
scoped to a workspace or conversation where applicable. Auto mode approves
approval-requiring actions for that run but does not bypass hard blocks.

### Stop and cancellation

Stopping a turn aborts model inference, releases pending questions/approvals,
and propagates cancellation into supported tools. Owned command sessions are
terminated when an aborted turn unwinds. Browser and network operations receive
the turn's abort signal.

### Durable tasks, Process, and checkpoints

The durable task runner supports approved background todo execution. The Process
subsystem supports phase graphs, fan-out, nested subprocesses, rework flagging,
and internal durable checkpoints. These checkpoints are implementation
infrastructure; there is no model-facing `checkpoint_manager` tool.

### Memory

An automatic memory pipeline records eligible top-level turns and maintains
memory skills for identity, preferences, workspace knowledge, and lessons. This
is a background mechanism, not a callable `memory_tool`; agents read surfaced
memory through the normal skill system.

### Tool output handling

Tool outputs are bounded and UTF-8-safe, and tool messages are persisted in the
conversation transcript. A separate large-result object store with a generic
page-back tool is **not implemented**; tool-specific paging exists for files,
documents, commands, and test results, while other oversized results may still
be truncated.

### Agentic loop

The model/tool loop continues until the model returns a turn with no tool calls
or the run stops or fails. Tool calls and results are durably tracked, including
lifecycle and reconciliation data for side-effecting operations.

## Not yet implemented

The following candidates from the original `hermes-tools/` review remain
unimplemented as model-facing capabilities:

- **Computer use** — arbitrary desktop/OS interaction; distinct from the
  implemented browser tools.
- **`skill_manager`** — model-facing creation and editing of skills. Skills are
  currently loaded/read, while automatic memory owns its managed skill files.
- **`tool_search`** — progressive disclosure/search over the built-in tool
  catalog. MCP discovery is bounded, but it is not exposed through a native
  tool-search bridge.
- **`tool_result_storage`** — generic durable storage and later paging of large
  tool results.
- **`cronjob` / `blueprints`** — user-authored scheduled or recurring agent runs.
- **`code_execution`** — a sandboxed script that programmatically invokes agent
  tools through RPC. Shell execution is not this capability.
- **`checkpoint_manager`** — model-facing checkpoint creation/restoration. The
  existing task and Process checkpoints are internal.
- **`kanban` and `project_tools`** — model-facing board/project management tools.
- **Media and service integrations** — built-in TTS, transcription, image/video
  generation, Discord, Home Assistant, Feishu, X search, send-message, and
  similar tools. Some integrations may be supplied externally through MCP, but
  they are not built-in tools.

The earlier `read_extract`, `process_registry`, web, browser, subagent, MCP,
memory-infrastructure, checkpoint-infrastructure, and execution-environment
candidates have now been implemented as described above.
