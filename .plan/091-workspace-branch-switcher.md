# PR91: Workspace branch switcher and branch creation

> Status: **PLANNED**. Turn the composer branch badge into an accessible branch menu that lists local branches, switches safely between them, and creates a new local branch through a confirmation modal.

## Goal

Replace the current static branch badge beside the workspace folder with a real button. Activating it shows the repository's local branches, marks the current branch, and lets the user switch by selecting another branch. The menu also offers **New branch…**, which opens a modal for the branch name and creates/switches to it.

Branch operations remain explicit user actions. The UI must not discard, stash, overwrite, or merge working-tree changes to make a switch succeed.

## Current state

- `src/renderer/src/App.tsx` owns `gitBranch`, refreshes `window.cowork.git.branch(workspace)` every two seconds and on focus, and renders a static badge beside the workspace selector. With the activity panel closed it shows icon plus branch text; when the panel is open it shows only the icon.
- `src/main/git/service.ts` already exposes `branches()`, returning bounded local branches with current/upstream metadata, and `branchName()`. The agent tool uses the richer branch list, but the renderer preload currently exposes only `git.branch`, not `git.branches`.
- The existing Git service resolves repository roots from nested workspace folders and worktrees, executes Git as argv with prompts/pagers disabled, and understands detached HEAD.
- PR90 introduces a narrow renderer Git-action surface, per-repository operation serialization, typed Git errors, and a lightweight Git-state refresh signal. This plan should reuse those pieces when PR90 lands first, but can be implemented independently by adding the minimal shared infrastructure rather than duplicating incompatible contracts.

## Product decisions

1. **Location and responsive behavior:** preserve the badge's current composer location and visual footprint. Convert both expanded (icon + truncated branch name) and compact (icon-only) variants into one accessible trigger with the same full-name title/label.
2. **Repository scope:** list **local branches only** in v1, matching `GitService.branches()`. Do not implicitly fetch or present remote-tracking branches as switch targets.
3. **Menu behavior:** open a searchable command/menu surface when practical; for small repositories, a scrollable menu is sufficient. Always mark the current branch and disable re-selecting it. Sort deterministically with current first, then local names case-insensitively with a case-sensitive tie break.
4. **Refresh on open:** request a fresh branch list whenever the menu opens. Do not rely solely on the two-second badge poll. Show loading, no-repository, detached-HEAD, empty, truncated, and recoverable-error states.
5. **Switch semantics:** selecting a branch runs the equivalent of safe `git switch <validated-local-branch>`. Never add `--force`, auto-stash, reset, clean, merge, or discard changes. If local changes or untracked files would be overwritten, leave the repository untouched and display Git's bounded explanation in an error modal.
6. **Branch identity:** the renderer sends an exact branch name returned by the immediately preceding list response. The main process still validates it, confirms it resolves to one local `refs/heads/*` ref, and passes it as argv after `--` where supported. Do not accept revisions, tags, remote refs, option-like names, or arbitrary checkout expressions.
7. **New branch flow:** a persistent **New branch…** menu item opens a modal with one text field, Cancel, and **Create branch**. On confirmation, create a local branch at the current `HEAD` and switch to it atomically (equivalent to `git switch -c <name>`).
8. **Name validation:** trim only accidental surrounding whitespace for validation/input normalization, then require the exact resulting name to pass Git's own `check-ref-format --branch` plus explicit rejection of blank/control/NUL input and a conservative UI length bound. Show validation inline before submission where possible; the main process remains authoritative.
9. **Existing names:** if the name already exists as a local branch, creation fails with a clear inline/modal error. Do not reinterpret that as a switch and do not overwrite/reset the existing branch.
10. **Dirty worktrees:** creating a branch at current `HEAD` is allowed with dirty changes because Git carries them into the newly checked-out branch without discarding them. Switching to an existing branch is allowed only when Git itself can do so safely.
11. **Detached HEAD:** the trigger displays the existing short SHA behavior. The menu explains that HEAD is detached, still lists local branches for switching, and allows creating a new branch from the detached commit. No implicit rescue branch is created.
12. **Concurrency:** disable branch selection/creation while any Git mutation for the same repository is running. If PR90 exists, use its repository operation coordinator so Pull/Commit/Push and branch switching cannot race the index, refs, or HEAD.
13. **Success behavior:** after a successful switch/create, close the menu/modal, immediately update the badge, refresh the branch list/status, and emit the shared Git-state-changed signal. The Files tree/preview and any Changes review must not show stale content from the previous branch; clear/reload workspace-derived views through existing watcher/refresh seams.
14. **Errors:** branch list failures may render inline in the menu. Switch/create failures use the reusable Git error modal introduced by PR90 when available; otherwise add the same bounded/selectable error treatment. Never expose stack traces, credentials, environment values, or unrelated absolute paths.
15. **No confirmation on ordinary switch:** choosing a named branch is itself the explicit action. The new-branch modal provides confirmation for creation. Do not add an extra generic confirmation dialog unless later UAT demonstrates accidental switches.

## Architecture

### Git service methods

Extend `GitService` with narrow branch mutation methods:

```ts
type GitBranchActionResult =
  | { ok: true; branch: string }
  | { ok: false; error: string }

switchBranch(name: string): Promise<GitBranchActionResult>
createBranch(name: string): Promise<GitBranchActionResult>
```

Exact result names may align with PR90's common `GitActionResult`. Both methods must:

- resolve and lock by repository root;
- validate that the workspace is a repository;
- validate branch names independently of renderer input;
- use argv execution, not shell interpolation;
- re-check relevant state inside the serialized operation;
- use non-interactive Git with bounded stdout/stderr and an explicit timeout;
- return renderer-safe typed errors; and
- verify the resulting attached branch before reporting success.

For switching, confirm the exact name exists under local `refs/heads`. For creation, validate with Git and confirm it does not exist before invoking atomic create-and-switch. These checks improve diagnostics but do not replace handling a race at the final Git command.

### IPC/preload contract

Expose the existing rich branch listing and the two mutation methods through the narrow preload bridge:

```ts
window.cowork.git.branches(workspace): Promise<GitBranchesResult>
window.cowork.git.switchBranch(workspace, name): Promise<GitBranchActionResult>
window.cowork.git.createBranch(workspace, name): Promise<GitBranchActionResult>
```

Keep `git.branch` for the lightweight badge refresh unless implementation cleanly consolidates it without increasing poll cost. Register handlers beside the existing Git IPC. Runtime-validate all arguments and never expose a generic Git command endpoint.

### Renderer component

Extract the current badge into a focused component such as `src/renderer/src/components/git-branch-switcher.tsx`. `App.tsx` passes the current workspace, compact state (`rightPanelOpen`), and a success callback or refresh token.

The component owns menu-open state, fresh branch-list loading, selected operation progress, new-branch modal state, validation feedback, and stale-response protection. Reset all transient state when workspace/conversation changes. Use existing dropdown/dialog primitives and command-menu primitives if they provide correct focus behavior; do not place a native selector inside a Dialog in ways known to conflict with modal pointer handling.

If repositories with many branches make the standard dropdown unwieldy, use the existing `cmdk`/Command-style searchable popover. Cap renderer rows according to the service result and visibly report truncation rather than pretending the list is complete.

### Cross-surface refresh

A branch switch can replace most files in the working tree without changing the workspace path. The existing `App.tsx` branch polling updates only the badge; it is not enough to reset workspace-derived renderer state. Reuse the file-watcher and Git refresh mechanisms already present after PR89/PR90:

- update the badge immediately from the successful result;
- trigger a fresh status/branch read;
- invalidate/reload Files tree caches and selected preview if their file changed or disappeared;
- clear stale turn-scoped Changes previews where appropriate; and
- ensure the workspace index's branch metadata is kicked/refreshed through the existing index watcher contract when available, without blocking the UI switch on a full re-index.

Prefer one explicit `git-state-changed` event carrying the workspace/repository identity and reason (`branch-switched`/`branch-created`) over adding more polling intervals.

## Implementation plan

### 1. Expose and test rich branch listing

Add `GitBranchesResult` to preload/renderer exports and a `git.branches(workspace)` IPC handler. Harden deterministic ordering and caps in `GitService.branches()` if needed. Cover normal repositories, many branches/truncation, nested workspace roots, worktrees, Unicode/slash names, detached HEAD, no repository, and command failures.

### 2. Implement safe branch switch/create operations

Add authoritative name/ref validation, local-branch existence checks, repository-root serialization, safe switch, and atomic create-and-switch. Reuse PR90's coordinator/error result if present. Real-Git integration tests must cover:

- switching between local branches in a clean worktree;
- switching with harmless dirty changes that Git can carry;
- refusal when tracked or untracked files would be overwritten, with tree/index/HEAD unchanged;
- creating from attached and detached HEAD;
- names containing slashes and valid Unicode;
- blank, control/NUL, option-like, revision-expression, invalid ref, duplicate, and oversized names;
- a branch deleted/created between validation and execution;
- no repository and missing Git executable; and
- concurrent branch/Git operations being serialized.

### 3. Add narrow IPC and preload methods

Register branch list/switch/create handlers beside `git:branch` and `git:status`. Validate workspace and branch arguments at the handler and service boundaries. Return typed results with bounded messages. Add IPC/preload tests that prove arbitrary command flags, remote refs, and revisions cannot pass through the contract.

### 4. Convert the badge into a branch trigger

Extract and replace both static badge variants in `App.tsx`. Preserve compact behavior when the right panel is open, truncation when expanded, full accessible label/title, focus styling, and current layout. The trigger should be disabled when workspace/repository state is unavailable and expose busy state during a mutation.

### 5. Build the local branch menu

Load branches on every open with request sequencing keyed to workspace. Render current branch, other local branches, detached state, loading/error/empty/truncated feedback, and New branch. Add search if branch volume warrants it. Selecting a branch closes or disables the list while switching, reports errors without losing context, and ignores stale completions after a workspace change.

### 6. Build new-branch modal and validation

Implement controlled input with autofocus, Enter-to-submit when valid, Escape/Cancel, inline validation, duplicate feedback, and pending state. On success, close/reset and update immediately. On failure, keep the entered name available for correction. Prevent double submits and stale success from switching the UI for a different workspace.

### 7. Integrate refresh and reusable error UI

Wire successful operations into PR90's Git refresh/error infrastructure or introduce the minimal shared equivalent if this phase lands first. Confirm the Files panel's live watcher handles checkout bursts; add an explicit cache invalidation event if watcher coalescing can otherwise leave stale selected content. Avoid a full index rebuild on the UI's critical path.

### 8. Verify UI and regressions

Run focused Git service, IPC/preload, and branch-switcher renderer tests, then `pnpm typecheck`, `pnpm test`, and `pnpm build`. Manually exercise expanded/compact badges, activity panel transitions, keyboard-only navigation, long/slashed branch names, many branches, dirty/conflicting worktrees, detached HEAD, branch creation validation, rapid workspace switching, Files panel open during checkout, and concurrent attempts with PR90 actions.

## Acceptance criteria

- The existing composer branch badge is an accessible button in both text and compact icon forms, with the current branch available through visible or accessible labeling.
- Opening it performs a fresh bounded local-branch read, marks the current branch, and handles loading, errors, detached HEAD, and truncation clearly.
- Selecting another local branch safely switches to it without force, stash, reset, clean, merge, or data loss.
- Branch input cannot be used as Git options, revisions, remote refs, or shell syntax; only an exact validated local branch returned/listed by the repository may be selected.
- A failed switch leaves HEAD, index, and working tree unchanged and shows a bounded useful error, including when local changes would be overwritten.
- New branch opens a modal, validates with Git-compatible rules, rejects duplicates, creates at current HEAD, and switches atomically.
- Valid slash and Unicode branch names work; invalid, blank, option-like, control-character, and oversized names are rejected without mutation.
- Dirty changes carry into a newly created branch; detached HEAD users can create a branch from the detached commit.
- Branch changes are serialized with other Git mutations, immediately update the badge, and invalidate branch/status/file views so prior-branch data is not presented as current.
- Existing workspace selection, model/agent/mode controls, branch polling fallback, Files/Changes views, and Chat behavior retain their existing behavior.

## Likely files

- Modify: `src/main/git/service.ts`
- Modify: `src/main/git/service.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/types.ts`
- Create: `src/renderer/src/components/git-branch-switcher.tsx`
- Create: focused renderer tests/helpers adjacent to the switcher
- Modify: `src/renderer/src/App.tsx`
- Possibly modify: PR90's shared Git action coordinator/error modal/refresh event
- Possibly modify: `src/renderer/src/components/files-panel.tsx` for explicit checkout invalidation

## Dependencies and sequencing

- Preferred order: implement PR90 first, then PR91, so this phase reuses its repository operation lock, typed mutation errors, reusable error modal, and Git-state refresh event.
- If PR91 lands first, keep those shared pieces in neutral Git modules/components and have PR90 adopt them later. Do not create two incompatible operation locks or error contracts.
- PR91 does not depend on AI commit-message generation or commit selection.

## Out of scope

- Remote branch listing/checkout, fetch-on-open, tracking setup, upstream editing, branch rename/delete, merge, rebase, cherry-pick, stash, reset, clean, force checkout, tags, worktree creation, or branch comparison/history UI.
- Automatically resolving checkout conflicts or offering destructive recovery buttons in the error modal.
- Creating a branch from an arbitrary revision; v1 always branches from current `HEAD`.
- Agent-callable branch mutation tools.
- Persisting menu search/selection state across workspaces or restarts.
