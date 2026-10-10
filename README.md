# North Star

A desktop AI agent built with Electron, Vite, and React. It works inside a
user-selected workspace and supports OpenAI, OpenAI-compatible, and Portkey API
providers, plus experimental OpenAI (Codex) and Anthropic (Claude) subscription
providers and Claude Code / Codex CLI providers. The agent can call server-side
tools: workspace file access is confined to the selected folder, and local shell
commands run on the host from that folder under an approval policy.

## Features

- **Conversation modes:** Default, Plan, and Auto. North Star conversations
  start in Auto unless you pick another mode.
- **Approvals:** risky actions pause for approval. You can remember a decision
  for the workspace or the conversation, allow every action of a kind for a
  conversation or task, or allow all file changes at once. Shell, delete,
  network, and other irreversible actions always stay exact-match.
- **Background tasks:** hand off a task list to run in the background. Results
  report back to the conversation, and a failed task can be retried, optionally
  on another model. Interactive, work, and background tasks run in separate
  lanes so upkeep never blocks a chat.
- **Subagents, skills, and MCP servers** extend what the agent can do.
- **Dashboards:** live widgets built from data the agent fetched, refreshed
  from a stored recipe.
- **Chat Python environment:** chat turns use a shared app-managed venv
  (`~/.<system-name>/venv`), so `pip install` never touches your global Python.
- **Workspace index:** symbol and file index (TypeScript, JavaScript, Python)
  for fast code navigation.
- **Mission Control** (feature-flagged): a team of agent seats that plans and
  runs Features, Milestones, and User stories in isolated git worktrees, with
  Playbooks, a Navigator, Comms, health monitoring, and a merge queue. Enable it
  with `NEXT_mission_control=true`.

## Getting started

Install dependencies, start the development app, then configure a provider account
and model in **Settings** before beginning a conversation:

```bash
pnpm install
pnpm dev
```

Provider API keys are encrypted with Electron `safeStorage` (typically backed by
the OS keychain). They remain in the main process and are never exposed to the
renderer. Secure storage must be available to save a key.

## Architecture

```
src/
  main/          Electron main process (Node)
    index.ts       window lifecycle + IPC handlers + .env.local loading
    agent/         provider-agnostic agent loop, tools, approval policy, MCP, skills, subagents
      providers/     provider routing + Codex and Claude subscription transports
      env/           execution backends (local host or Docker/Podman container)
    tasks/         background task runner, handoffs, and report-back updates
    mission-control/  agent seats, playbooks, worktrees, merge queue (feature-flagged)
    python/        managed chat venv
    dashboards/    live dashboard storage and refresh
    conversations/ db/  conversation history and SQLite persistence
    settings/ config/   provider accounts, feature flags, branding, theme
    browser/ terminal/ git/ files/ index/  supporting services for tools and UI
    pick-workspace.ts  native OS folder picker (dialog.showOpenDialog)
  preload/       contextBridge → window.cowork (chat, tasks, providers, settings, …)
  renderer/      React UI (Vite). @/* → src/renderer/src
  shared/        types shared between main and renderer
```

The renderer never touches Node or the network directly — it calls the main
process over IPC through the `window.cowork` bridge defined in `preload/`.

## Scripts

```bash
pnpm dev           # run the app with HMR (electron-vite dev)
pnpm build         # build all three processes into out/
pnpm preview       # preview the production build
pnpm start         # alias for pnpm preview
pnpm dist          # build + package a distributable (electron-builder)
pnpm format        # format TypeScript and TSX files
pnpm typecheck     # run tsc --noEmit
pnpm test          # rebuild SQLite for Node, run the full suite, then restore Electron modules
pnpm test:sqlite   # run SQLite-backed Vitest files with zero SQLite skips, then restore Electron modules
pnpm test:watch    # run Vitest in watch mode
pnpm verify:roadmap # validate roadmap documentation
```

`postinstall` rebuilds native modules for Electron. Both test commands temporarily
rebuild `better-sqlite3` for the Node runtime that runs Vitest, then restore
`better-sqlite3` and `node-pty` for Electron even if tests fail. Native rebuilds
require the local platform build toolchain.

## Configuration

Configure provider accounts and their models in **Settings**. Available providers:

- **OpenAI - API**, **OpenAI-Compatible - API**, and **Portkey - API** (API key)
- **OpenAI Subscription - Experimental** (ChatGPT/Codex device sign-in)
- **Anthropic Subscription - Experimental** (keyless; uses your own installed
  native Claude Code CLI, signed in with `claude auth login` to a personal Pro or
  Max account. North Star does not install or update the CLI, and it refuses to
  run under managed policies, configured proxies, or organization/API-key auth)
- **Claude Code CLI - Experimental** and **Codex CLI - Experimental**

API keys are encrypted with the OS-backed secure storage service; there is no
environment-variable fallback for configured provider credentials.

`.env.local` is loaded by the main process for non-secret local configuration.
Copy `env.example` to `.env.local` to start. Supported options include:

- `NEXT_system_name` / `MAIN_AGENT_NAME`: app and agent branding
- `COWORK_ENV_RUNTIME` (`docker` | `podman`) and `COWORK_ENV_IMAGE`: run agent
  tools in a container instead of on the host
- `COWORK_LOCAL_PROFILE` (`read-only` | `workspace-write` | `host-access`):
  access profile for local execution
- `NEXT_mission_control`: set to `true` to enable Mission Control
- `NEXT_accent_color` / `NEXT_neutral_color`: theme presets (quote hex values)

## Prompts & Skills

```
prompts/
  _core/                         Shared behavior and safety policy
  chat-system-prompt.md          Chat-mode instructions
  interactive-system-prompt.md   Interactive-mode instructions
  north-star-system-prompt.md    North Star-mode instructions
skills/
  git-commit/                    Built-in git commit skill
  skill-creator/                 Built-in skill authoring and evaluation skill
  youtube-content/               Built-in YouTube transcript and summary skill
agents/
  *.agent.md                     Built-in agent definitions (coding, builder, QA, orchestrator)
```

At startup, each conversation mode composes the shared prompt core with its
mode-specific prompt. Skills can also be loaded from configured custom and
workspace-level sources. The built-in `prompts/`, `skills/`, and `agents/`
directories are bundled into the distributable alongside `out/`.

## Adding an agent tool

1. Create `src/main/agent/tools/my-tool.ts` exporting a `Tool`.
2. Import it in `src/main/agent/tools/index.ts` and add it to the appropriate tool
   collection (`workspaceTools`, `otherTools`, or another explicitly gated group).
3. Add the tool definition wherever its availability is assembled when it should be
   offered only in a particular mode or capability set.

For a filesystem tool, route model-supplied paths through the hardened workspace
environment helpers so it inherits workspace confinement and no-follow protections.

## UI components

shadcn/ui components live in `src/renderer/src/components/ui` and are imported
via the `@/` alias:

```tsx
import { Button } from "@/components/ui/button"
```
