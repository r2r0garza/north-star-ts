# Agent notes

This is an **Electron + electron-vite + React** desktop app (migrated from
Next.js). There is no Next.js, no server, and no `/api` routes.

## Process boundaries — keep these straight

- **`src/main/`** — Node/Electron main process. Filesystem, Portkey calls, and
  the native folder picker live here. This is the only place with Node access.
- **`src/preload/`** — the `contextBridge`. The ONLY surface the renderer may
  use to reach main is `window.cowork`. Add a new capability by adding an
  `ipcRenderer.invoke` wrapper here AND an `ipcMain.handle` in `src/main/index.ts`.
- **`src/renderer/`** — React UI. No Node, no `fs`, no `fetch` to localhost.
  Talk to main via `window.cowork.*`. `@/*` resolves to `src/renderer/src/*`.

## Conventions

- Tools confined to the workspace: route all model-supplied paths through
  `resolveInWorkspace(ctx.workspace, path)` in `src/main/agent/tools/`.
- The Portkey client is constructed lazily (`getClient()`) so it reads
  `process.env` after `.env.local` is loaded — don't move it back to module scope.
- `package.json` is intentionally NOT `"type": "module"` (electron-vite emits
  CJS for main/preload). Config files are `.mjs`/`.ts` and unaffected.
