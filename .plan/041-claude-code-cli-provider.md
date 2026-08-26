# PR41: Claude Code CLI provider

> Status: **IMPLEMENTED** on `feat/cli-agents`.
> Split out of `034` after live CLI probes on 2026-08-25/26. This is the first
> external-agent provider slice: **Claude Code** as a local subprocess backend.

## Context

Claude Code is not an OpenAI-compatible LLM account. It is an autonomous local
agent CLI with its own prompt assembly, tools, approvals, session store, auth,
MCP config, and output stream. When a conversation selects Claude Code, the app
should route the user message to `claude` instead of entering our `runAgentLoop`.

This means our internal tools, skills, context builder, workspace index,
approval gate, plan/default/auto mode behavior, and backend container selection
do not apply to the turn. We persist the user/assistant messages in our DB for
history, but Claude owns the execution.

## Verified CLI behavior

Probes saved under `cli_probes/claude/`.

- Installed probe version: `2.1.231 (Claude Code)`.
- JSON one-shot works:
  - `claude -p <message> --session-id <uuid> --output-format json`
  - Emits one JSON object with `type:"result"`, `session_id`, final `result`,
    usage, model usage, cost, timing, and error fields.
- Streaming with tool output works:
  - `claude -p <message> --resume <session_id> --output-format stream-json --verbose`
  - Emits JSONL events including:
    - `system` init and hook events
    - `assistant` messages with `content[].type:"tool_use"`
    - `user` messages containing `tool_result`
    - `tool_use_result.stdout` / `stderr`
    - final `type:"result"` with final `result`, `session_id`, usage, cost, timing
- Caller-assigned session id works with `--session-id <uuid>`.
- Resume works with `--resume <session_id>`.
- Path/CWD behavior:
  - `claude --help` does **not** expose a `--cwd`/`-C` flag.
  - Claude uses the spawned process working directory as its project/current
    directory.
  - `--add-dir <directories...>` only grants access to additional directories;
    it is not the primary working-directory selector.
  - Probe `cli_probes/cwd/claude-cwd.stdout` confirmed `system.init.cwd` and
    Bash `pwd` match the child process `cwd`.
  - Probe `cli_probes/cwd/claude-chat-cwd.stdout` confirmed Claude works from
    an external empty/non-project chat directory and records that path as `cwd`.
- Sandboxed probes could not see Claude auth; real use must spawn in the normal
  host environment where Claude can access its signed-in state.

## Goal

Add `Claude Code` as a selectable local CLI provider for both workspace-backed
and Chat conversations, with multi-turn continuity, live token/tool-output
rendering where available, durable transcript persistence, and clear UI
signaling that the conversation is handled by Claude's own local agent.

## Scope

### Provider and detection

- Add a provider kind for Claude Code, likely `claude_code_cli` or
  `claude_code`.
- No API key, no base URL, no model import.
- Detect with `claude --version`.
- Allow an optional binary path override later if needed; v1 can rely on `PATH`
  if the existing provider-settings shape makes that simpler.
- Surface installed/not installed/auth failure clearly in Settings or the model
  picker.

### Session state

- Persist a per-conversation CLI session reference.
- For Claude, generate a UUID before the first turn and store it.
- First turn command shape:
  - `claude -p <message> --session-id <uuid> --output-format stream-json --verbose`
- Later turn command shape:
  - `claude -p <message> --resume <session_id> --output-format stream-json --verbose`
- The target path is **not** passed as an argv flag for Claude. It is passed via
  `spawn(command, args, { cwd: targetDir })`.
- Always pass arguments via `spawn` argv arrays, never shell-quoted strings.

### Runtime behavior

- Route Claude Code conversations away from `runAgentLoop`.
- Spawn with an explicit `cwd`; never inherit the Electron app's current
  directory accidentally.
- For Interactive and North Star, set `cwd` to the resolved conversation
  workspace/project directory. That is how terminal usage works: Claude treats
  the process working directory as the project it may inspect and edit.
- For Chat, use an app-managed empty/non-project directory for the conversation,
  for example `path.join(app.getPath("userData"), "cli-chat-workdirs",
  conversationId)`. Chat has no workspace, so the CLI must not be launched from
  the repo root or any incidental process cwd. The directory must also not sit
  under a project/git tree, because Claude can discover parent project context.
  It should behave as a normal chat-like Claude session with no project context
  beyond the user's message and Claude's own session memory.
- Force/local-lock backend behavior for this provider.
- Disable or hide our Default/Plan/Auto mode controls for Claude Code turns.
- Do not expose our tools, skills, index, approval gate, or custom-agent tool
  restrictions to Claude Code.

### Event parsing

- Parse stream JSONL incrementally.
- Render assistant text from assistant message content blocks.
- Render tool activity from `tool_use` blocks when present.
- Render tool output from `tool_use_result.stdout` / `stderr` when present.
- Use the final `result` event as the authoritative final assistant text when
  present.
- Preserve raw/unknown events only in logs/debug artifacts, not as chat text.

## Implementation notes

- Add an `agent/cli/` adapter layer rather than extending `createCompletion`.
- Add a shared CWD resolver for CLI providers:
  - workspace-backed modes -> resolved workspace/project path, and fail clearly
    if missing
  - Chat -> stable app-owned chat directory scoped by conversation id, outside
    any workspace/project tree
  - all paths -> absolute and created/validated before spawn
- Claude adapter path rule: set only process `cwd`; use `--add-dir` later only
  for explicit additional directory access, not for the main project/chat path.
- The adapter should expose common operations:
  - detect binary/version
  - ensure or create session reference
  - build argv for first/resume turn
  - parse JSONL events into app-level events
  - return final text and session reference
- Use the same abort/process-group discipline as local shell execution so Stop
  kills the Claude process tree.
- Persist our own user/assistant messages as usual; do not try to import
  Claude's full native transcript.

## Verification

1. Unit-test argv construction for first turn and resume turn.
2. Unit-test parser against `cli_probes/claude/01-json.stdout` and
   `cli_probes/claude/02-stream-tool.stdout`.
3. Manual: select Claude Code in an Interactive workspace conversation, send a
   no-edit prompt, confirm streaming/final text and DB transcript.
4. Manual: confirm the Claude process cwd is the selected workspace path.
5. Manual: select Claude Code in Chat, send a no-tool prompt, and confirm the
   process cwd is the app-owned chat directory, not the project repo.
6. Manual: send a harmless tool prompt and confirm tool use/output renders.
7. Manual: second turn resumes the same Claude session.
8. Manual: Stop kills an in-flight Claude turn.
9. Manual: missing binary or not-logged-in output becomes a clear user-facing
   error.

## Out of scope

- In-app Claude login.
- Mapping our approval policy onto Claude's permission flags.
- Injecting our skills/index/context into Claude Code.
- Container execution.
- Copilot support.

## Implementation result

- Added `claude_code` as a credential-free provider with `claude --version`
  detection in Settings.
- Added schema v29 and `cli_sessions` for one caller-assigned native session id
  per conversation, including cascade cleanup.
- Added `agent/cli/` with safe argv arrays, host-PATH resolution, incremental
  JSONL parsing, authoritative final-result handling, and process-group Stop.
- Routed Claude Code before North Star's internal context/tools/skills/MCP/
  approval/environment setup. Workspace modes spawn in the selected directory;
  Chat uses an app-owned per-conversation directory under `userData`.
- Hid custom-agent, Default/Plan/Auto, and background-run controls while Claude
  Code is selected; user/assistant turns remain durable in the app transcript.
- Verified `pnpm build`; 828 tests pass. The only full-suite failures are the
  environment-dependent Docker/Podman container setup suites. The three
  repository-wide `pnpm typecheck` errors are pre-existing and unchanged.

## 041.1 — Durable Claude model aliases

> Status: **IMPLEMENTED** on `feat/cli-agents`.

Claude Code owns model availability and does not expose a stable non-interactive
catalog command for our OpenAI-style gateway importer. The provider therefore
uses Claude Code's durable aliases instead of `Import from gateway`:

- Seed exactly `sonnet`, `haiku`, `opus`, and `fable` for every new Claude Code
  provider account. Sonnet is first/favorited and is the provider fallback.
- Selecting the Claude Code provider without a model selects Sonnet. Explicitly
  selecting any alias passes that alias through to the CLI.
- Add `--model <alias>` on first and resumed argv. Legacy `claude-code` or null
  selections normalize to `sonnet`.
- Schema v30 migrates existing Claude accounts: replaces the legacy model row,
  updates affected conversations/global defaults to Sonnet, and seeds all four
  aliases idempotently.
- The Models surface renders a fixed alias selector for Claude Code. It omits
  gateway import, arbitrary add, rename, favorite, and delete controls because
  Claude owns discovery and alias resolution.

Verification: argv/default normalization tests plus explicit v30 legacy-backfill
coverage; included in the full regression result recorded in the roadmap.
