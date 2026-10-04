# North Star

A desktop AI agent built with Electron, Vite, and React. It works inside a
user-selected workspace and supports Portkey, OpenAI, OpenAI-compatible, and
experimental Codex subscription providers. The agent can call server-side tools:
workspace file access is confined to the selected folder, and local shell commands
run on the host from that folder under an approval policy.

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
    agent/         provider-agnostic agent loop + tools (filesystem confinement, shell policy)
    pick-workspace.ts  native OS folder picker (dialog.showOpenDialog)
  preload/       contextBridge → window.cowork.{chat, pickWorkspace}
  renderer/      React UI (Vite). @/* → src/renderer/src
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

Configure provider accounts and their models in **Settings**. North Star supports
Portkey, OpenAI, OpenAI-compatible gateways, and experimental Codex subscription
accounts. API keys are encrypted with the OS-backed secure storage service; there
is no environment-variable fallback for configured provider credentials.

`.env.local` is loaded by the main process for non-secret local configuration, such
as the optional `NEXT_system_name` system-name override.

## QA checks and Playwright

In Mission Control, the QA seat writes acceptance checks into the workspace's checks
directory (`e2e/` by default). UI checks are usually Playwright specs. Your project
doesn't need Playwright for them: when it has no `@playwright/test`, North Star runs
the specs with its own bundled copy, using the app itself as Node, so you don't need
Node installed either. When your project has Playwright, North Star uses yours, with
your `playwright.config` merged under its own settings.

Those specs therefore run inside North Star, but **not from your own terminal**
(`npx playwright test`) unless you add `@playwright/test` to your project. North Star
never adds it for you.

Browser checks use your installed Google Chrome. Without Chrome, North Star asks once
(in Mission Control, or **Settings → General → Browser → Test browser for QA checks**)
before downloading Playwright's test browser into its own app data. Until then, checks
that need a browser are recorded as not verifiable. Electron apps are checked with
Playwright's `_electron.launch`, which needs no browser.

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
```

At startup, each conversation mode composes the shared prompt core with its
mode-specific prompt. Skills can also be loaded from configured custom and
workspace-level sources. The built-in `prompts/` and `skills/` directories are
bundled into the distributable alongside `out/`.

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
