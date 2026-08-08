# PR34: CLI-agent providers — Claude Code, Codex, and Copilot as subprocess backends

> Status: **NOT STARTED**. Adds three new **provider kinds** that are not LLM-API accounts but local
> **agentic CLIs** we drive as subprocesses: **Claude Code** (`claude -p`), **OpenAI Codex**
> (`codex exec`), and **GitHub Copilot CLI** (`copilot -p`). Each *is* the agent — it runs its own
> loop, tools, and approvals **inside the project directory** — so selecting one **routes away from our
> `runAgentLoop`** to a subprocess runner, **locks the execution backend to Local**, and **disables Chat
> mode** (these CLIs must run in a folder). Continuity is per-turn: turn 1 opens/creates a session,
> later turns resume it. **Research is done** (see "CLI behavior" — flags verified live against
> `claude`/`codex-cli 0.146.0`/`copilot 1.0.78` on 2026-08-07); the session model is **not uniform**
> across the three, which shapes the state design.

## The core idea

Today every provider is an LLM-API account: `Provider` (`db/types.ts`) ∈
`portkey|openai_compatible|openai|anthropic|google|azure_openai`, resolved by `agent/providers/index.ts`
(`buildClient` → `createCompletion`/streaming), and a turn runs through `runChat` → **`runAgentLoop`**
(our model→tools cycle) confined to a `workspace` via the `Environment` backend
(`env/factory.ts`, Local/Docker/Podman).

A **CLI-agent provider is a different animal**: we don't call a chat API and run our own tool loop — we
**spawn a CLI that owns the whole loop** and edits files directly in the project dir. So the provider
selection has to fork the pipeline much earlier than `buildClient`:

- **Route:** when a conversation's provider is a CLI kind, `runChat` dispatches to a new
  **subprocess runner** (`agent/cli/runner.ts`) instead of `runAgentLoop`. The runner spawns the CLI
  with `cwd` = the conversation's project dir, streams stdout back as assistant output over the same
  `onEvent` channel the renderer already consumes, and persists the turn.
- **Backend lock:** a CLI agent runs on the host in the project folder → the `Environment`/container
  backend is **irrelevant and must be forced to Local**. `getExecutionConfig` (and the Settings UI)
  gate the backend to `local` and disable the Docker/Podman choice whenever the active conversation's
  provider is a CLI kind.
- **Mode restriction:** these CLIs **require a working directory**, and **Chat mode has no workspace**
  (`conversations.mode='chat'`; `resolveConversationDir` returns undefined; the sidebar's own
  new-conversation gate is `mode === "chat" || !!project.workspaceId`). So a CLI provider is only valid
  in **Interactive / North Star ([agent-name])** where a workspace exists; **Chat is disabled** when a
  CLI provider is selected (and, symmetrically, a CLI provider can't be picked for a Chat conversation).

## CLI behavior (researched + verified live 2026-08-07 — pin versions; flags shift between releases)

The session-continuity model is the crux and it **differs by tool**:

| | headless turn | continue same convo | self-assign id? | structured out | approvals (no TTY) | model | cwd |
|---|---|---|---|---|---|---|---|
| **Claude Code** | `claude -p "msg"` | same cmd `--session-id <uuid>` | **YES** — `--session-id <uuid>` creates on turn 1 | `--output-format json` (has `session_id`) | `--permission-mode` / `--allowedTools` (default: non-read tool → non-zero exit, no prompt) | `--model` (+ `--append-system-prompt`) | process `cwd` |
| **Copilot CLI** (`1.0.78`) | `copilot -p "msg"` | same cmd `--session-id=<uuid>` | **YES** — `--session-id=<uuid>` creates on turn 1 | `--output-format json` (JSONL; **field names unverified**) | **`--allow-all-tools` REQUIRED** for non-interactive (`--allow-tool`/`--deny-tool` to scope; deny wins) | `--model` | `-C <dir>` (or `cwd`) |
| **Codex** (`codex-cli 0.146.0`) | `codex exec "msg"` | `codex exec resume <id> "msg"` | **NO** — id is a Codex-minted UUIDv7 | `--json` (JSONL; id = `thread_id` on the first `thread.started` line) | default `approval_policy:never` + `sandbox:read-only`; **`-s workspace-write`** to edit; **no `--full-auto`/`-a` in 0.146** | `-m` | `-C <dir>` (also `--skip-git-repo-check`, pass prompt as arg + close stdin) |

**Consequence for the state model:** Claude + Copilot let us **generate the UUID ourselves** and pass
the same one every turn (no output parsing). Codex forces **extract-then-resume** — parse `thread_id`
from turn 1's first JSONL event, store it, and `codex exec resume <thread_id>` thereafter. So the
per-conversation "session token" is **assigned by us OR captured from turn 1**, per provider.

## Goal

1. Add **`claude_cli` / `codex_cli` / `copilot_cli`** as provider kinds, configurable like any provider
   account (but with **no API key** — instead: a detected/اconfigurable **binary path**, a health check
   `--version`, and default flags: model, permission/sandbox posture).
2. When a conversation uses a CLI provider: **route turns to the subprocess runner** (not
   `runAgentLoop`), **lock the backend to Local**, and **disable Chat mode** for that conversation
   (and hide/disable CLI providers in the Chat model picker).
3. **Multi-turn continuity** via a per-conversation **session token** — self-assigned (claude/copilot)
   or captured from turn-1 JSONL (codex) — persisted so every later turn resumes the same CLI session.

## Likely shape (hypothesis — revisit per Open questions)

### A. Provider model + storage
- Extend the `Provider` union (`db/types.ts`) with `claude_cli|codex_cli|copilot_cli` and a
  `providerKindIsCli(p)` predicate. A CLI provider account carries **no `encrypted_key`**; reuse the
  `provider_accounts` row for a **binary path + default-flags JSON** (or a small additive column) —
  `hasKey` semantics don't apply, so the Providers UI shows a **binary path + a "Detected ✓ / Not
  found" health check** (`which claude` / `--version`) instead of a key field.
- A **session token per (conversation, provider)**: add nullable **`cli_session_id`** (+ maybe
  `cli_provider`) to `conversations` (additive `SCHEMA_V20+`). NULL = no session yet → turn 1
  creates/assigns it; set thereafter. (Codex writes it from parsed output; claude/copilot write the
  UUID we generated before spawning.)

### B. Subprocess runner (`src/main/agent/cli/`)
- A per-provider **adapter** encapsulating the differences above: `buildArgs(turn, sessionId, dir,
  model, posture)`, `parseEvents(stdout)` (JSONL → assistant text + a captured session id for codex),
  and the resume convention. Three adapters (`claude.ts`/`codex.ts`/`copilot.ts`) behind one interface,
  chosen off the provider kind — mirroring `providers/index.ts`'s `buildClient` switch.
- **`runner.ts`** spawns via the existing detached-process-group machinery (`005`'s
  `LocalEnvironment.exec` orphan-kill pattern — so Stop/abort kills the whole CLI process tree), streams
  stdout, maps CLI JSONL events onto our `onEvent` stream (assistant deltas / a final result / tool
  activity where the CLI surfaces it), and persists the turn like `runAgentLoop` does. Runs on the
  **`009` durable task** seam too, so a CLI turn can go background / resume (session id makes resume a
  natural `codex exec resume` / `--session-id` re-invoke).
- **Approvals:** these CLIs run their own approval loop with **no TTY**, so v1 must pass the
  non-interactive posture (`claude --permission-mode`/`--allowedTools`; `copilot --allow-all-tools`;
  `codex -s workspace-write`). This **bypasses our `002`/`012` gate** for CLI turns — a deliberate,
  documented v1 tradeoff (the CLI is the trust boundary), surfaced in the UI. Tightening (mapping our
  allowlist onto per-tool flags) is deferred.

### C. Routing, backend lock, mode gate
- `runChat` (`agent/index.ts`) branches on `providerKindIsCli(conversation.provider)` → the CLI runner;
  everything else stays on `runAgentLoop`.
- `getExecutionConfig`/`env/factory.ts` + the Settings **backend** control: when the active
  conversation's provider is a CLI kind, **force `backend:'local'`** and disable the container options
  (with an explanatory note).
- Sidebar/composer: **Chat** view is disabled (or the CLI provider is unselectable) for CLI providers;
  the model picker filters accordingly. The `VIEW_TO_MODE`/new-conversation gate
  (`sidebar.tsx` ~474/516) already ties non-chat modes to a workspace — extend it so a CLI provider
  **requires** a workspace-backed mode.

### D. Settings / provider config UI
- A CLI provider setup card: **binary path** (auto-detected via `which`, overridable), a **health
  check** (`--version`), **model** default, and the **permission/sandbox posture** toggle. No key, no
  base URL. "Coming soon"→"configured" mirrors the existing provider onboarding.

## Open questions to resolve BEFORE building
1. **Approval posture in v1.** Accept that CLI turns bypass our gate (pass the non-interactive
   auto-allow flags, CLI owns trust) vs. attempt to bridge prompts (hard — no TTY, each CLI differs).
   Lean **bypass-with-clear-UI in v1**, allowlist-bridging deferred.
2. **Streaming fidelity.** Map each CLI's JSONL stream onto our `onEvent` richly (tool calls, reasoning)
   vs. v1 = **assistant text + final result only**. Lean **text-first**; richer mapping later. (Copilot
   JSONL field names are **unverified** — confirm against one authenticated run before parsing.)
3. **Auth.** Each CLI manages its own auth (Claude subscription/login, Codex ChatGPT/ OpenAI, Copilot
   GitHub). v1 assumes the user has logged the CLI in out-of-band; we only detect the binary + run it.
   Surface a clear "not authenticated" error from a non-zero exit. Do we shell a login helper? Lean
   **out-of-band login, detect + explain**.
4. **Backend-lock UX.** Hard-lock to Local silently vs. show the lock with a reason. Lean **show + explain**.
5. **Split on build** (`025.x` pattern): `034.1` one provider end-to-end (**Claude Code** — self-assign
   id, cleanest) → `034.2` **Copilot** (same self-assign model) → `034.3` **Codex** (extract-then-resume
   `thread_id`, the different one). Backend-lock + mode-gate land in `034.1`.
6. **Model list.** CLI providers don't expose a `/models` catalog like the gateway. Hard-code a small
   known set per CLI (+ a free-text override), or just a free-text model field. Lean **free-text +
   a few presets**.

## Verification (when built)
- **Unit:** each adapter's `buildArgs` produces the correct turn-1 vs resume command (self-assigned
  UUID for claude/copilot; `codex exec` then `codex exec resume <thread_id>`); `parseEvents` extracts
  assistant text and (codex) the `thread_id` from a stubbed JSONL fixture; the `providerKindIsCli`
  routing + backend-lock + Chat-disable gates.
- **Manual (real app):** configure Claude Code (detect binary), start an **Interactive** conversation
  in a real repo, send turn 1 (file edit lands in the repo), send turn 2 and confirm context carried
  (same session), Stop mid-turn kills the CLI tree; confirm **Chat is disabled** and **backend shows
  Local locked**; repeat for Copilot and Codex. Confirm a non-zero exit (e.g. not-logged-in) surfaces a
  clear error, not a hang.
- `pnpm typecheck` + `pnpm build` clean; verified in the running app.

## Out of scope
- **Bridging our approval gate / allowlist onto CLI per-tool flags** — v1 passes the CLI's own
  non-interactive posture; mapping is later.
- **Rich tool/step visualization** from the CLI stream — v1 is text + final result.
- **Managing CLI auth / login flows in-app** — the user logs the CLI in out-of-band.
- **Running CLI agents in a container** — they're host+Local by definition here; containerizing a CLI
  agent is a separate effort.
- **MCP servers the CLIs expose** — orthogonal; the CLI manages its own MCP config.
