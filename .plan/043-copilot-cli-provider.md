# PR43: Copilot CLI provider

> Status: **DEFERRED**.
> Split out of `034` after live CLI probes on 2026-08-25/26. This keeps the
> research and intended shape recorded, but implementation is intentionally last
> behind Claude Code and Codex CLI.

## Context

GitHub Copilot CLI is also an autonomous local agent CLI. It has its own session
store, tools, permissions, JSONL stream, GitHub auth, and model routing. It can
fit the same external-agent provider architecture as Claude Code and Codex CLI,
but v1 support is deferred because tool permissions are riskier to validate.

During probing, no-tool JSON streaming worked. A shell-tool probe with
`--allow-tool=shell` was rejected by the approval reviewer because it grants the
Copilot model shell execution in an escalated signed-in environment. That is a
real product/safety concern, not just a test inconvenience.

## Verified CLI behavior

Probes saved under `cli_probes/copilot/`.

- Installed probe version: `GitHub Copilot CLI 1.0.80`.
- Help confirms:
  - `-p, --prompt <text>` for non-interactive mode
  - `--session-id <id>` to resume an existing session/task or set the UUID for a
    new session
  - `--resume[=value]`
  - `--output-format json`
  - `--stream on|off`
  - `--allow-tool`, `--deny-tool`, `--allow-all-tools`, `--allow-all`
- No-tool JSON streaming works:
  - `copilot --prompt <message> --session-id <uuid> --output-format json --stream on`
  - Emits JSONL events including:
    - session MCP/status/skills events
    - `user.message`
    - `assistant.turn_start`
    - `model.call_start`
    - `assistant.reasoning_delta`
    - `assistant.message_start`
    - `assistant.message_delta`
    - `assistant.message`
    - `assistant.turn_end`
    - `session.usage_checkpoint`
    - final `result` with `sessionId`
- Caller-assigned session id works.
- Reusing the same `--session-id` resumes the session.
- `--stream off` still emitted rich JSONL in the probe, so the adapter should
  not assume buffered mode means one final JSON object.

## Goal

Eventually add `Copilot CLI` as a selectable local CLI provider using the same
external-agent adapter layer, but only after Claude Code and Codex CLI are
working and after we decide how to handle Copilot's non-interactive tool
permission posture safely.

## Deferred scope

### Provider and detection

- Add a provider kind for Copilot CLI, likely `copilot_cli`.
- No API key, no base URL, no model import.
- Detect with `copilot --version`.
- Surface installed/not installed/auth failure clearly.

### Session state

- Generate a UUID for the first turn and store it as the conversation's CLI
  session reference.
- Reuse the same UUID with `--session-id` on later turns.
- Always pass arguments via `spawn` argv arrays.

### Runtime behavior

- Route Copilot CLI conversations away from `runAgentLoop`.
- Spawn with an explicit `cwd` or `-C`; never inherit the Electron app's current
  directory accidentally.
- For Interactive and North Star, set the working directory to the resolved
  conversation workspace/project directory.
- For Chat, use an app-managed empty/non-project directory scoped by
  conversation id so Copilot behaves like a chat-like session instead of
  accidentally treating the repo root or app process cwd as its workspace.
- Force/local-lock backend behavior for this provider.
- Disable or hide our Default/Plan/Auto mode controls for Copilot CLI turns.
- Do not expose our tools, skills, index, approval gate, or custom-agent tool
  restrictions to Copilot CLI.

### Event parsing

- Parse JSONL incrementally.
- Render `assistant.message_delta` as streaming assistant text.
- Use `assistant.message.content` as the final assistant text.
- Use final `result.sessionId` to verify session continuity.
- Revisit tool output after a separately approved bounded probe identifies safe
  flags and exact event shapes.

## Open questions before implementation

1. Can we support useful Copilot CLI turns without granting broad tool access?
2. What is the minimum safe non-interactive permission posture?
3. Should the app expose Copilot CLI as no-tool/chat-like only, or wait until
   tool output and edit behavior are understood?
4. How should reasoning deltas be handled in the UI, if at all?

## Verification when revisited

1. Unit-test parser against `cli_probes/copilot/01-json-stream.stdout`,
   `cli_probes/copilot/03-json-resume.stdout`, and
   `cli_probes/copilot/04-json-buffered.stdout`.
2. Manual: no-tool prompt streams/finalizes correctly.
3. Manual: second turn resumes the same session id.
4. Separately approved manual: bounded tool probe confirms event shape and
   safety posture before enabling tool-capable Copilot turns.

## Out of scope for now

- Implementing Copilot CLI provider support in the near term.
- Running shell-tool probes without explicit approval.
- Mapping our approval policy onto Copilot permissions.
- In-app Copilot login.
