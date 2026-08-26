# Cowork

A desktop AI agent (Electron + Vite + React) that works inside a user-selected
workspace folder. The agent talks to Claude via a Portkey gateway and can call
server-side tools. File tools are confined to the chosen workspace; Local shell
commands run on the host with the workspace as their working directory and are
guarded by approval policy.

## Architecture

```
src/
  main/          Electron main process (Node)
    index.ts       window lifecycle + IPC handlers + .env.local loading
    agent/         Portkey agentic loop + tools (filesystem confinement, shell policy)
    pick-workspace.ts  native OS folder picker (dialog.showOpenDialog)
  preload/       contextBridge → window.cowork.{chat, pickWorkspace}
  renderer/      React UI (Vite). @/* → src/renderer/src
```

The renderer never touches Node or the network directly — it calls the main
process over IPC through the `window.cowork` bridge defined in `preload/`.

## Scripts

```bash
pnpm dev        # run the app with HMR (electron-vite dev)
pnpm build      # build all three processes into out/
pnpm start      # preview the production build
pnpm dist       # build + package a distributable (electron-builder)
pnpm typecheck  # tsc --noEmit
```

## Configuration

The Portkey API key is read from the environment, `NEXT_apiKey` taking priority
over a system-wide `PORTKEY_API_KEY`. Put a local key in `.env.local`:

```
NEXT_apiKey=your-key-here
```

`.env.local` is loaded by the main process at startup (Electron does not do this
automatically the way Next.js did).

## Prompts & Skills

```
prompts/
  system-prompt.md   The agent's system prompt, loaded at conversation start
skills/
  git-commit         Skill definition for the git-commit tool
```

These directories are bundled into the distributable alongside `out/`.

## Adding an agent tool

1. Create `src/main/agent/tools/my-tool.ts` exporting a `Tool`.
2. Import it in `src/main/agent/tools/index.ts` and add it to the `registry`.

Resolve any model-supplied filesystem path through
`resolveInWorkspace(ctx.workspace, path)` to inherit workspace confinement.

## UI components

shadcn/ui components live in `src/renderer/src/components/ui` and are imported
via the `@/` alias:

```tsx
import { Button } from "@/components/ui/button"
```
