# PR42: Codex CLI provider

> Status: **DONE**.
> Split out of `034` after live CLI probes on 2026-08-25/26. This is the second
> external-agent provider slice: **Codex CLI** as a local subprocess backend.

## Context

Codex CLI is an autonomous local agent CLI. It owns its tool loop, approval
posture, session store, auth, and JSONL event stream. When selected as a
provider, the app should send the user's message to `codex exec` rather than
entering our OpenAI-compatible provider path or `runAgentLoop`.

The current app still owns conversation persistence and UI history, but Codex
owns execution. Our tools, skills, workspace index, approval gate, plan/default/
auto controls, and container backend do not apply to Codex CLI turns.

## Verified CLI behavior

Probes saved under `cli_probes/codex/`.

- Installed probe version: `codex-cli 0.147.0`.
- `codex --version` may print non-fatal warnings before/around the version, so
  detection should tolerate stdout/stderr noise and rely primarily on exit code
  plus a version pattern.
- Initial JSONL turn works:
  - `codex exec --json --sandbox read-only --skip-git-repo-check <message>`
  - Emits:
    - `thread.started` with `thread_id`
    - `turn.started`
    - `item.started` / `item.completed`
    - `command_execution` items with `command`, `aggregated_output`,
      `exit_code`, and `status`
    - `agent_message` item with final text
    - `turn.completed` with usage
- Resume works:
  - `codex exec --json --sandbox read-only --skip-git-repo-check resume <thread_id> <message>`
  - Re-emits `thread.started` with the same `thread_id`.
- Codex does not accept a caller-assigned new session id for `exec`; we must
  capture the `thread_id` from the first turn and persist it.
- `-p` is not prompt mode for `codex exec`; it means profile. The prompt is a
  positional argument or stdin.
- Path/CWD behavior:
  - `codex --help` and `codex exec --help` expose `-C, --cd <DIR>`:
    "Tell the agent to use the specified directory as its working root."
  - Codex also inherits the process cwd, but `-C/--cd` is the explicit working
    root selector and should be used by the adapter.
  - `--add-dir <DIR>` grants additional writable directories alongside the
    primary workspace; it is not the primary working-root selector.
  - Probe `cli_probes/cwd/codex-cwd-flag.stdout` confirmed `codex exec -C
    <target>` runs agent commands from `<target>` even when the spawned process
    was launched from the repo root.
  - Probe `cli_probes/cwd/codex-chat-cwd.stdout` confirmed `codex exec
    --skip-git-repo-check -C <external-empty-dir>` works for a non-project Chat
    cwd.
- Git-repo check behavior:
  - Codex may refuse to run in a non-git folder unless `--skip-git-repo-check`
    is present.
  - Do not hard-code this flag only for Chat. A user can choose a normal folder
    for Interactive/North Star too.
  - Reuse our existing git detection (`readGitBranch(targetDir)` in
    `src/main/index/metadata.ts`). If it returns a git value (`branch` or
    detached `sha`), omit `--skip-git-repo-check`. If it returns `null`, include
    `--skip-git-repo-check`.

## Goal

Add `Codex CLI` as a selectable local CLI provider for both workspace-backed and
Chat conversations, with captured `thread_id` continuity, JSONL event parsing,
tool-output rendering from Codex items, durable transcript persistence, and
clear UI signaling that Codex is running as its own local agent.

## Scope

### Provider and detection

- Add a provider kind for Codex CLI, likely `codex_cli`.
- No API key, no base URL, no model import.
- Detect with `codex --version`.
- Tolerate warning output during detection.
- Surface installed/not installed/auth failure clearly.

### Session state

- Persist a per-conversation CLI session reference.
- First turn has no session reference:
  - run `codex exec --json ... <message>`
  - parse `thread.started.thread_id`
  - store it on the conversation before or during turn completion
- Later turns:
  - run `codex exec --json ... resume <thread_id> <message>`
- Always include `-C <targetDir>` for both first and resume turns. Also set the
  spawned process `cwd` to the same `targetDir` for consistency and for any
  auxiliary process-relative behavior.
- Include `--skip-git-repo-check` when the target directory is not detected as a
  git repo by our own git probe. This applies to Chat, Interactive, and North
  Star.
- Treat a missing `thread_id` from an otherwise successful first turn as an
  adapter error because resume continuity would be broken.
- Always pass arguments via `spawn` argv arrays.

### Runtime behavior

- Route Codex CLI conversations away from `runAgentLoop`.
- Spawn with an explicit `cwd`; never inherit the Electron app's current
  directory accidentally.
- For Interactive and North Star, set `cwd` to the resolved conversation
  workspace/project directory. That is how terminal usage works: Codex treats
  the process working directory as the project it may inspect and edit.
- For Chat, use an app-managed empty/non-project directory for the conversation,
  for example `path.join(app.getPath("userData"), "cli-chat-workdirs",
  conversationId)`. Chat has no workspace, so the CLI must not be launched from
  the repo root or any incidental process cwd. The directory must also not sit
  under a project/git tree. It should behave as a normal chat-like Codex session
  with no project context beyond the user's message and Codex's own thread
  memory.
- Force/local-lock backend behavior for this provider.
- Disable or hide our Default/Plan/Auto mode controls for Codex CLI turns.
- Do not expose our tools, skills, index, approval gate, or custom-agent tool
  restrictions to Codex CLI.

### Event parsing

- Parse `--json` JSONL incrementally.
- Capture `thread.started.thread_id`.
- Render `agent_message.text` as assistant text.
- Render `command_execution` items as tool activity, including
  `aggregated_output`.
- Leave room for later support of `file_change`, `mcp_tool_call`,
  `web_search`, `todo_list`, and `error` item types from Codex's documented
  event schema.
- Use `turn.completed.usage` for optional usage display/logging.

## Implementation notes

- Add this through the same `agent/cli/` adapter layer as Claude Code.
- Reuse the shared CWD resolver from the Claude slice:
  - workspace-backed modes -> resolved workspace/project path, and fail clearly
    if missing
  - Chat -> stable app-owned chat directory scoped by conversation id, outside
    any workspace/project tree
  - all paths -> absolute and created/validated before spawn
- Keep Codex-specific command construction in `codex.ts`.
- Codex adapter path rule: set process `cwd` to the target directory and pass
  `-C <targetDir>` explicitly. Run `readGitBranch(targetDir)` first; add
  `--skip-git-repo-check` only when it returns `null`.
- Use `--json` for all app-driven turns.
- Use a conservative default sandbox first. The probes used `--sandbox read-only`
  for safety. The product decision for editing support is whether v1 defaults to
  `read-only` or `workspace-write`; expose this clearly if configurable.
- Use the same abort/process-group discipline as local shell execution so Stop
  kills the Codex process tree.

## Verification

1. Unit-test argv construction for first turn and resume turn.
2. Unit-test parser against `cli_probes/codex/01-json-tool.stdout` and
   `cli_probes/codex/02-json-resume.stdout`.
3. Manual: select Codex CLI in an Interactive workspace conversation, send a
   no-edit prompt, confirm final text and DB transcript.
4. Manual: confirm the Codex process cwd is the selected workspace path.
5. Manual: select Codex CLI in Chat, send a no-tool prompt, and confirm the
   process cwd is the app-owned chat directory, not the project repo.
6. Manual: first turn stores `thread_id`.
7. Manual: second turn resumes the same `thread_id`.
8. Manual: harmless command/tool item renders with `aggregated_output`.
9. Manual: Stop kills an in-flight Codex turn.
10. Manual: missing binary or auth failure becomes a clear user-facing error.

## Out of scope

- In-app Codex login.
- Mapping our approval policy onto Codex's sandbox/approval settings.
- Injecting our skills/index/context into Codex.
- Container execution.
- Copilot support.
