# PR30: Process artifacts — per-phase dot-folders + file chips → open in IDE

> Status: **NOT STARTED**. Follow-up on `026` (Process UI) surfaced by live testing. Two paired
> quality-of-life features that make a phase's *output* visible and openable: (a) an optional
> per-phase **dot-folder** convention so a phase's artifacts land in a predictable place, and (b)
> **file chips** on each phase card in the run monitor that open a produced file in the user's IDE.
> Mostly renderer + one small additive column; **no scheduler change**. Independent of `029`/`031`.

## Context

A phase worker runs `runAgentLoop` in a forked conversation in the run's workspace (`run.workspaceId`
→ path, from `026`). Its "output" is free-form — the monitor shows status/agent/title but nothing
about *what files* it wrote or where. Two existing facilities make this cheap:

- **Open-in-IDE:** `window.cowork.openInEditor(workspace, relPath)` (preload ~L383) → `open-in-editor`
  IPC → `src/main/ide/open.ts` `openInIde` (opens repo root then the file in the settings-selected
  IDE). Takes a workspace-relative path; **no line-number support** today.
- **Changed-files derivation:** the app does **not** have a workspace-wide "changed files" git call.
  The renderer derives changed files from the agent's **tool calls** — `changedFilesFromCalls(calls)`
  in `src/renderer/src/lib/timeline.ts` (~L79-94) scans `edit_file_tool`/`write_file_tool` for
  `args.path` → `ChangedFile[]`. Reusable chip UIs already exist: `ChangedFilesBar`
  (`changed-files-bar.tsx`), `ChangesPanel` + `FilePreview` (`changes-panel.tsx`, `diff-view.tsx`),
  all wiring `openInEditor` + `git.diff` for the hover preview.

## Goal

### 030a — Per-phase dot-folder toggle
When on for a phase, its agent is steered to write artifacts under `.<phase.key>/` (e.g. Plan →
`.plan/PLAN.md`), giving a **predictable path** — the payoff being that 030b's chips are reliable and
a downstream phase knows where to look.

### 030b — File chips → open in IDE
Each phase card in the run monitor shows the files that phase produced as clickable chips; clicking
opens the file in the selected IDE, hover shows a git-diff preview.

## Likely shape (hypothesis — revisit per Open questions)

### 030a
- **Schema:** `process_phases.dot_folder INTEGER NOT NULL DEFAULT 0` (additive `ALTER`, mirrors the
  `026` `workspace_id`/`title` migrations; bump the `user_version` assertions).
- **Type/repo/preload:** add `dotFolder` to `ProcessPhase` + row/mapper + `createPhase`/`updatePhase`
  + the `db:processes:phases:*` preload input types.
- **Builder:** a `dot_folder` `Switch` in the `PhaseCard` inspector (mirror the existing fan-out
  toggle) in `process-screen.tsx`.
- **Engine:** `kickoffPrompt` (`prompts.ts` ~L16-44; also `eachSubtaskKickoffPrompt`) gains an
  optional line — "Write any files you create under `.<phase.key>/` …" — when the phase's
  `dotFolder` is set. A **convention** (an instruction the agent follows), not FS-enforced.

### 030b
- Resolve a phase-run's produced files with **no new git machinery**: `phaseRun.taskId` → worker
  `conversationId` → `window.cowork.db.messages.list(convId)` → `buildTimeline(rows)` →
  `changedFilesFromCalls(calls)` → `ChangedFile[]`.
- Render a chip row on each phase card (and each child row) in the monitor, feeding the run's
  workspace path. Reuse `ChangedFilesBar` (refactor it to optionally take a precomputed
  `ChangedFile[]` rather than only deriving from `calls`), or the lighter `FilePreview` + a plain
  chip. Click → `openInEditor(workspace, relPath)`.
- The run's workspace path: `run.workspaceId` → `db.workspaces` (resolve once in `RunMonitor`).

## Open questions to resolve BEFORE building
1. **Chip data source** — reuse the tool-call derivation (matches the chat UI, no baseline) vs. add a
   workspace-wide `git diff --name-status` main-process call (more accurate for files a phase changed
   via shell, not just the edit/write tools). Lean **tool-call derivation** for v1 (consistent, no
   new IPC), note the shell-write gap.
2. **Where the chips render** — inline under each phase card (denser) vs. only in an expanded
   transcript view. Lean inline, collapsed past N (the `ChangedFilesBar` MAX_VISIBLE pattern).
3. **Dot-folder key collision** — two phases with related keys, or a `.plan/`-style folder that
   already means something in the repo. It's advisory (agent-followed), so low-risk, but the prompt
   wording should say "if it doesn't already exist / for this run's artifacts".
4. **Open-at-line** — `openInIde` has no line support; out of scope unless trivial (`code -g
   file:line`), and only some IDEs support it.

## Verification (when built)
- `pnpm typecheck` + `pnpm build` clean; migration DB test (dot_folder column) under a node-ABI
  rebuild, Electron ABI restored after.
- Manual E2E: toggle dot-folder on the Plan phase, run, confirm the plan lands in `.plan/`; confirm
  each phase card shows file chips that open in the selected IDE and hover-preview the diff.

## Out of scope
- Enforcing the dot-folder at the filesystem layer (it's an agent convention).
- Workspace-wide git-diff tracking / shell-written file detection (noted as a v1 gap).
- Open-at-specific-line in the IDE.
