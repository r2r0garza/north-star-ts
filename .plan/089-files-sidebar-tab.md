# PR89: Workspace Files sidebar tab

> Status: **PLANNED**. Add a read-only Files tab to the right sidebar with a lazy workspace tree on the right and a selected-file preview on the left, separated by a draggable divider.

## Goal

Make the active conversation's current working directory browsable without leaving North Star. The right-sidebar tab set becomes **Info**, **Browser**, **Changes**, and **Files**. Opening Files shows two panes: a file preview on the left and the workspace tree on the right. Expanding a directory reveals its direct children; selecting a file loads it into the preview.

This phase is a workspace explorer and viewer, not an editor.

## Current state

- `src/renderer/src/components/activity-panel.tsx` owns the right-sidebar tab model. `SidebarTabKind` currently contains `info | browser | changes`; the plus menu and empty state enumerate those same three kinds, while the Shell's `openSidebarTab` logic already guarantees at most one open tab per kind.
- `src/renderer/src/main.tsx` owns the tabs, active tab, sidebar open state, active workspace path, and the outer sidebar width. The workspace path is empty for Chat/no-workspace sessions.
- The right sidebar itself is already resizable from its left edge and persists one shared width in `sidebar_browser_width`. Files should use that existing outer resize behavior rather than create a separate sidebar.
- `window.cowork.files.list(workspace, query)` is built for the composer typeahead. It returns only files, recursively walks and caches the workspace, applies the shared skip/gitignore rules, and caps results at 50. It cannot correctly back an expandable directory tree and must not be repurposed for this feature.
- `window.cowork.files.readText(workspace, relPath)` already performs a workspace-confined, real-path-checked read and caps previews at 256 KiB. The approval review UI already uses this endpoint for read-only source previews.
- There is no filesystem watcher available yet (`024` remains future work), so v1 needs explicit refresh behavior rather than claiming a live tree.

## Product decisions

1. **Workspace scope:** “cwd” means the active conversation's workspace root already reported to the Shell. Files is unavailable as a useful browser in Chat mode or whenever that root is empty.
2. **Pane order:** the selected-file preview is the left pane and the tree is the right pane, exactly as requested. The vertical separator between them is draggable.
3. **Lazy tree:** opening the Files tab lists only the workspace root's direct children. Expanding a directory requests only that directory's direct children. Collapsing a directory keeps its loaded children cached for the current workspace so reopening is instant.
4. **Ordering:** directories sort before files; each group sorts by display name with a deterministic, case-insensitive comparison and a case-sensitive tie break.
5. **Visibility:** show the directory structure as it exists, including dotfiles and gitignored entries. Lazy loading avoids a whole-repository traversal. Do not follow or expand symbolic links in v1; represent them as non-expandable entries if they are returned.
6. **Read-only preview:** selecting a regular file loads a bounded preview. Text/source files render as selectable, scrollable text with a filename/path header and an **Open in editor** action. Empty files render a clear empty-file state. Oversized text shows the existing truncation notice. Binary, unsupported, missing, and unreadable files show a non-destructive explanatory state rather than mojibake or an app error.
7. **Selection:** directory clicks toggle expansion and do not replace the current file preview. File clicks select and preview. Selection and expansion are renderer-local and reset when the active workspace changes; no SQLite migration is needed.
8. **Refresh:** include a small refresh action for the tree. It clears loaded directory entries, reloads the root, removes selections that no longer exist when discovered, and leaves the UI usable if refresh fails. Automatic filesystem watching is deferred to `024`.
9. **Internal resize:** the tree/preview split is independent of the existing outer sidebar width. Keep both panes above practical minimum widths, clamp on window/sidebar resize, and persist the tree pane width (or split ratio) in a dedicated cookie/local setting. The separator must support pointer dragging and keyboard adjustment with an accessible separator role/value.
10. **One tab per kind:** Files follows the existing tab behavior—choosing it opens or activates the single Files tab; it can be closed like the other tabs.

## Architecture

### Directory service and IPC

Add a dedicated, lazy directory-listing service under `src/main/files/` rather than extending the flat mention typeahead contract. A representative result is:

```ts
export type WorkspaceEntry = {
  name: string
  path: string // workspace-relative POSIX path
  kind: "directory" | "file" | "symlink" | "other"
}

window.cowork.files.listDirectory(
  workspace: string,
  relDirectory: string
): Promise<{ entries: WorkspaceEntry[]; error: string | null }>
```

Exact names may follow local conventions, but the renderer needs typed entry kind, name, and relative path. Keep failures in a small renderer-safe result rather than exposing host stack traces.

The main-process implementation must:

- canonicalize and validate the workspace root and requested relative directory with the existing workspace-confinement helpers or an equivalent shared helper;
- reject absolute paths, traversal, sibling-prefix tricks, and paths whose real target leaves the workspace;
- use `readdir(..., { withFileTypes: true })` for one directory only—never recursively walk on expand;
- classify links with `lstat`/directory entries without following them for traversal;
- return POSIX-normalized relative paths on every platform;
- sort deterministically with directories first;
- bound the number of entries and response size for pathological single directories, returning an explicit truncation/error indication if a cap is reached; and
- tolerate entries disappearing between enumeration and classification.

Do not change the semantics or 50-result cap of the existing `files:list` mention endpoint.

### Preview contract

Reuse `files:readText` and its 256 KiB cap, but harden its result if needed so the renderer can distinguish a text preview from binary/unsupported content. Binary detection should use the existing `isBinaryBuffer` convention rather than decoding arbitrary bytes as UTF-8. A compatible additive result could include `kind: "text" | "binary"`; existing callers should continue to work without a flag day.

Keep all file reads main-process mediated and workspace confined. Renderer `file://` construction is not the general preview mechanism. Common image/document rendering is optional future work; v1 acceptance requires a sound text/source viewer and a clear unsupported state.

### Renderer composition

Create `src/renderer/src/components/files-panel.tsx` and keep tree/preview state out of the already-large `ActivityPanel`. `ActivityPanel` should only register the new kind, labels/menu buttons, and mount `<FilesPanel workspace={workspace} />` for the active Files tab.

Suggested component boundaries inside the file (extract only if tests or size justify it):

- `FilesPanel` — workspace resets, loading/error state, selected path, expanded set, child cache, refresh, and split width;
- `FilePreview` — bounded async read, stale-response cancellation, header/open-in-editor action, text/empty/truncated/unsupported/error states; and
- `FileTree` / `TreeRow` — recursive rendering over lazily loaded child maps, disclosure controls, indentation, icons, and accessible selection/expansion state.

Async responses must be keyed to both workspace and requested path. Switching conversations/workspaces or rapidly selecting files must not allow an older response to populate the new workspace or overwrite a newer selection.

## Implementation plan

### 1. Add and test the confined directory-listing service

Create a service such as `src/main/files/tree.ts` with focused unit tests. Cover root listing, nested direct-child listing, directories-before-files sorting, POSIX paths, dotfiles/gitignored entries, empty directories, unreadable/missing paths, per-entry disappearance, entry caps, traversal attempts, absolute paths, sibling-prefix escapes, and symlinks that point both inside and outside the workspace. Verify that symlink directories are never traversed.

Keep this independent from `src/main/files/list.ts`; both services may share a small path/sort helper only where that reduces duplicated security-sensitive logic without changing composer behavior.

### 2. Expose the tree through typed IPC/preload APIs

Register the new handler near the existing `files:list` and `files:readText` handlers in `src/main/index.ts`, and add its typed preload API in `src/preload/index.ts`. Validate all inputs in the main process even though the renderer supplies them.

Add IPC-level coverage where practical for empty workspace, valid nested paths, and rejected escape attempts. Error strings shown to the renderer should be useful but must not disclose unrelated host paths.

### 3. Make file preview binary-aware

Update the existing text-read service/handler to inspect the bounded prefix before UTF-8 decoding and return an additive text/binary classification. Preserve the current 256 KiB limit and the current `{ content, truncated, error }` behavior expected by approval review call sites.

Add tests for UTF-8 text, empty text, oversized text, NUL-containing binary data, missing files, directories passed as files, traversal, and a file replaced or redirected during resolution/read. If the existing real-path helper already owns race guarantees, test at the appropriate helper boundary rather than duplicating it.

### 4. Register the Files sidebar tab

In `activity-panel.tsx`:

- add `"files"` to `SidebarTabKind`;
- centralize the four tab kinds/labels in one typed constant so the plus menu and empty state cannot drift;
- render Files after Changes, yielding Info, Browser, Changes, Files everywhere the choices are presented; and
- route the active Files kind to `FilesPanel` with the current workspace.

Update stale comments in `activity-panel.tsx`, `main.tsx`, and `App.tsx` that describe the right sidebar as having fewer modes or say its workspace is only for Changes/Browser.

### 5. Build the lazy, accessible tree

Load the root when Files becomes active with a non-empty workspace. Render loading, empty-workspace, empty-directory, and recoverable error states. Directory rows expose expanded/collapsed state and load children on first expansion; file rows expose selected state and set the preview path.

Use semantic buttons/tree attributes with visible focus treatment. Ensure indentation does not make long names unusable: retain icons/disclosure controls, truncate labels, and expose the full relative path through title/accessibility text. Loading or failing one directory must not blank already loaded siblings.

The refresh button clears the current workspace's child cache and expanded state before reloading root. It must not invoke the recursive composer list API.

### 6. Build the left preview and stale-response protection

On file selection, call `window.cowork.files.readText(workspace, path)`. Render a stable empty state before selection and distinct loading, text, empty, truncated, binary/unsupported, and error states. Use a monospace `<pre>` or an existing safe highlighting/Markdown primitive only if it preserves literal source content; never execute HTML/scripts from workspace files in this panel.

Include the workspace-relative path and an **Open in editor** control wired to the existing `window.cowork.openInEditor(workspace, path)`. Cancel or ignore stale reads on selection/workspace changes.

### 7. Add the resizable internal separator

Implement a vertical divider between preview and tree with the tree on the right. Use pointer events so drag remains active when the cursor leaves the narrow handle, release pointer capture/handlers on completion and unmount, disable accidental text selection during drag, and clamp both panes to documented minimums.

Add `role="separator"`, vertical orientation, current/min/max values, focus styling, and arrow-key resizing. Persist only a bounded tree width or ratio in a Files-specific key; malformed/stale persisted values fall back safely. Re-clamp when the outer activity panel or window becomes narrower.

### 8. Verify integration and behavior

Add renderer tests around pure tree-update/split-clamp helpers and component behavior using the project's existing Vitest/happy-dom conventions. At minimum verify:

- the fourth tab is labeled and ordered correctly;
- selecting Files opens/activates one tab rather than creating duplicates;
- workspace changes clear stale tree/preview state;
- expanding a folder requests only that folder and does not refetch cached children;
- a failed child load is localized and retryable;
- rapidly selected files cannot display an older response;
- refresh invalidates the tree cache;
- drag and keyboard resize clamp correctly; and
- binary/truncated/error preview states render correctly.

Run focused tests, then `pnpm typecheck`, `pnpm test`, and `pnpm build`. Manually exercise the feature in Electron against a workspace containing nested folders, dotfiles, ignored folders, long names, an empty file, a large text file, a binary file, and symlinks.

## Acceptance criteria

- The right-sidebar choices appear in this order: Info, Browser, Changes, Files.
- Opening Files creates or activates one closable Files tab using the existing tab lifecycle.
- With an active workspace, the Files tab shows a two-pane layout: preview left, tree right.
- The tree initially reads only the workspace root and loads one directory level only when that directory is expanded.
- Folders expand/collapse in place; files can be selected and their bounded text content appears on the left.
- Directories precede files and names are deterministically sorted.
- Dotfiles and gitignored entries are visible; symlinks are never followed or expanded.
- Text, empty, truncated, binary/unsupported, loading, missing, and unreadable preview states are handled without crashing or executing workspace content.
- The internal separator resizes both panes by pointer and keyboard, remains clamped to usable bounds, and persists independently from the outer sidebar width.
- Switching workspace/conversation cannot display stale tree or file-read results from the prior workspace.
- A refresh action reloads the tree; v1 makes no false promise of live filesystem watching.
- Directory listing and file reads cannot escape the supplied workspace root.
- Existing composer file mentions, Changes, Browser, Info, sidebar resizing, and approval-review previews retain their behavior.

## Likely files

- Create: `src/main/files/tree.ts`
- Create: `src/main/files/tree.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Create: `src/renderer/src/components/files-panel.tsx`
- Create: renderer tests/helpers adjacent to `files-panel.tsx`
- Modify: `src/renderer/src/components/activity-panel.tsx`
- Possibly modify/add focused tests for `files:readText` and the workspace path helper
- Update stale right-sidebar comments in `src/renderer/src/main.tsx` and `src/renderer/src/App.tsx`

## Out of scope

- Editing, creating, renaming, moving, or deleting files and folders.
- Drag-and-drop, multi-select, context menus, upload/download, or clipboard file operations.
- Recursive eager loading, full-tree search/filter, or replacing the composer's existing `files:list` typeahead.
- Automatically revealing the active transcript file or synchronizing selection with an external IDE.
- Rendering arbitrary workspace HTML with script privileges.
- Full image, PDF, office-document, notebook, audio, video, or hex previews.
- Following symbolic links or browsing outside the active workspace.
- Live filesystem watching; integrate with `024` later if/when that watcher exists.
- Persisting expanded folders or selected files across app restarts.
