# 007 — View switcher, Chat mode & file attachments

**Area:** Renderer + main + preload — `src/renderer/src/components/sidebar.tsx`,
`src/renderer/src/main.tsx`, `src/renderer/src/App.tsx`,
`src/main/agent/index.ts`, `src/main/pick-workspace.ts`, `src/main/index.ts`,
`src/preload/index.ts`
**Status:** Implemented

## What

### Sidebar view switcher
A three-button group sits at the top of the sidebar (below the traffic-light /
toggle spacer): **Chat**, **Interactive**, **North Star**. The active view is
filled (`default` variant); the others are `outline`. Selection state lives in
`Shell` (`main.tsx`) and is passed down to both `AppSidebar` (controlled) and
`App` (which branches its composer on it). Default view is **North Star**.

- **North Star** — the existing workspace-backed panel: "Cowork" empty state,
  folder picker, filesystem tools confined to the chosen workspace.
- **Interactive** — currently **identical** to North Star (same component, same
  workspace behavior). Kept as a distinct view so it can diverge later; the
  `view` prop is already threaded into `App`.
- **Chat** — no workspace. The folder picker is replaced by a **+** button that
  attaches files; the agent runs without filesystem tools and reads file
  contents inlined into the prompt instead.

### Chat attachments
- **+** opens the native multi-file picker via a new `pickFiles` IPC
  (`pick-files` handler → `pickFiles()` in `pick-workspace.ts`, mirroring
  `pickWorkspace` but with `["openFile", "multiSelections"]`).
- Selected files appear as **removable chips** above the composer, de-duplicated
  by path, showing only the last path segment.
- **Send works with or without an attachment** — Chat requires only message
  text. The workspace views still require a selected folder.

### Optional workspace + inlined attachments (backend)
`ChatRequest.workspace` is now **optional** and `attachments?: string[]` was
added. In `runChat`:
- Workspace validation (absolute path, exists, is a directory) only runs when a
  workspace is provided.
- Filesystem tools (`toolDefinitions`) are only offered when there's a
  workspace to confine them to; `read_skill` is always offered (it's
  workspace-independent).
- Each attachment is read and inlined into the user message as a labeled,
  fenced block (`--- filename ---\n<contents>`), capped at **256 KB** per file;
  oversized/unreadable files become a short skipped-note rather than failing the
  turn.

## Why

- One window, multiple modes is cleaner than separate screens; the segmented
  button group is the standard affordance and reuses existing shadcn pieces.
- Chat-about-a-file shouldn't require choosing a workspace folder first.
  Inlining contents (vs. passing paths) means the model needs no filesystem
  access at all in Chat mode, keeping that mode sandbox-free by construction.
- Relaxing the workspace requirement to optional (rather than forking a second
  agent entrypoint) keeps a single `runChat` codepath for all three views.

## Trade-offs / notes

- **Supersedes the "Send requires a workspace" note in
  [001 — Chat UI](001-chat-ui.md).** That still holds for North Star /
  Interactive; Chat sends with no workspace.
- **Interactive == North Star for now.** Intentional placeholder. When it
  diverges, branch further on the `view` prop already passed to `App`.
- **Attachment size cap (256 KB) and inline-everything strategy** are a
  deliberate simplification — see `CONSIDERATIONS.md`. No content-type sniffing
  (binary files inline as UTF-8 garbage), no token budgeting across multiple
  files.
- **Main-process changes need a restart.** During this work a stale main build
  kept returning the old "valid absolute workspace path is required" error for
  Chat until the main process was rebuilt/restarted — only the renderer
  hot-reloads.
