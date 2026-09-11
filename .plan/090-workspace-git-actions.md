# PR90: Workspace Git actions and AI-assisted commits

> Status: **PLANNED**. Add user-driven Fetch, Pull, Commit, and Push controls for the active workspace, including grouped file-selective commits and tool-enabled AI commit-message generation.

## Goal

Place a Git actions button in the title bar immediately to the right of the theme toggle. The button opens a menu with **Fetch**, **Pull**, **Commit**, and **Push** for the active workspace repository. Network or Git failures are shown in a modal with Git's bounded error text. Commit opens a modal where the user selects changed files, writes a commit message, and can ask a tool-enabled LLM agent to inspect the selected prospective commit and draft that message.

This is a deliberate human-operated Git surface, not a new agent tool and not a general Git client.

## Current state

- `src/renderer/src/main.tsx` owns the title bar and active `workspacePath`. It mounts `HeaderThemeToggle` from `activity-panel.tsx` using a computed absolute right offset, alongside Terminal and Activity controls.
- `src/renderer/src/App.tsx` owns the composer-level branch badge and independently refreshes `window.cowork.git.branch(workspace)` every two seconds and on window focus.
- `src/main/git/service.ts` already provides an argv-safe, non-interactive `GitService` for status, diff, log, show, and local branch inspection. It resolves repository roots correctly for subdirectory workspaces and uses bounded output, disabled prompts, no pager, and no shell-string interpolation.
- The preload bridge currently exposes `git.branch`, `git.status`, and the single-file working-tree `git.diff`; mutation and network operations are not exposed to the renderer.
- `src/main/agent/index.ts` and the task runner provide the agent loop needed for a tool-enabled request; `src/main/agent/title.ts` provides the closest precedent for model routing, isolated CLI calls, output validation, and avoiding a synthetic turn in the user's conversation. Commit-message generation needs a deliberately restricted combination of those patterns rather than a plain completion.
- The existing status shape distinguishes index and worktree state, renames, conflicts, and untracked files. There is no staging UI today.

## Product decisions

1. **Placement:** render one compact Git actions button directly to the visual right of the theme toggle. Refactor the title-bar controls into a small coordinated group or compute both offsets from one source so they cannot overlap the Terminal, Activity, native window controls, or an open activity panel.
2. **Availability:** show the control only for a non-empty workspace-backed view. Disable it, with an explanatory title, when the folder is not a Git repository. Chat mode has no Git actions.
3. **Menu:** the button opens an accessible menu containing Fetch, Pull, Commit, and Push. Only one Git mutation/network action may run for that workspace at a time; show a spinner or disabled state until it settles.
4. **Fetch semantics:** run non-interactive `git fetch --prune` using configured remotes. Do not accept a remote URL from the renderer and do not fetch every remote implicitly.
5. **Pull semantics:** run a fast-forward-only pull for the current attached branch. This avoids creating an unexpected merge commit from a one-click title-bar action. Detached HEAD, no-upstream, authentication, conflicts, and non-fast-forward conditions are errors shown to the user; the app does not choose a branch, merge, rebase, stash, or reset.
6. **Push semantics:** push the current attached branch through its configured upstream. Do not silently create or select an upstream. Missing-upstream, rejected, authentication, hook, and network failures are shown to the user.
7. **Commit scope:** Commit opens a modal listing every changed file from a fresh status read in two sections: **Tracked** and **Untracked**. Both sections start expanded and can be collapsed or expanded independently. Each section header includes its selected/total count and a group-level selection control that selects or clears every committable file in that section. Every file also has its own checkbox for single-file selection. All committable files start selected by default.
8. **Selection semantics:** the Tracked group contains modified, added-to-index, deleted, renamed, and other tracked paths; the Untracked group contains new untracked paths. Group controls have checked, unchecked, and indeterminate states derived from their selectable children. Collapsing a group changes only visibility and never changes selection. Empty groups remain clearly labeled or are omitted according to the final visual treatment, but the grouping must never classify a path ambiguously.
9. **Commit contents:** the commit includes exactly the selected complete-file paths, including tracked edits/deletions/renames and selected untracked files. Unselected changes and unrelated pre-existing staged work must not be swept into the commit or discarded.
10. **Conflict handling:** unmerged/conflicted entries appear under Tracked but cannot be selected and do not count toward Select all. Explain that conflicts must be resolved first. If no committable file is selected, disable Commit.
11. **Commit message:** require a non-empty trimmed message, preserve intentional line breaks for subject/body, pass it without shell parsing, and apply a conservative maximum length. Do not rewrite user-entered text.
12. **AI generation:** **Ask AI** starts an isolated agent run rooted at the active workspace, with tools enabled and at minimum `exec_command` available so the model can run `git status`, `git diff`, and other necessary read-only Git inspection commands itself. Pass the exact currently selected tracked and untracked paths in the trusted request envelope and instruct the agent to inspect only the prospective commit. The run does not create transcript messages and never stages or commits automatically.
13. **AI tool scope:** the hidden run uses a dedicated commit-message capability profile. Although it exposes the normal exec tool interface, command policy for this run allows only read-only repository inspection and rejects commands that mutate files, the index, refs, remotes, configuration, or credentials. It has no file-write, patch, browser, memory, delegation, question, approval, or Git-mutation tools. Tool calls and output are bounded, cancellable when the modal closes/workspace changes, and executed through the existing workspace/runtime boundary rather than a renderer shell.
14. **Selected/untracked inspection:** the prompt tells the agent that ordinary `git diff` does not include untracked file contents and requires it to inspect selected untracked files through safe read-only commands when needed (for example a bounded no-index diff), while ignoring unselected paths. The final response must be based on the selected prospective commit, not every repository change.
15. **AI output contract:** after its tool calls, the agent must return strict JSON with only `commit_message`, and the prompt includes an example such as `{"commit_message":"feat(git): add workspace actions"}`. Validate and parse defensively because providers/CLI agents may emit wrappers or reasoning. Accept only one object with one string field, enforce the same message length limit, and show a recoverable inline error for malformed/provider responses.
16. **Prompt-injection boundary:** command output, diffs, filenames, and file contents are untrusted repository data, clearly provenance-wrapped and described as data that cannot alter instructions. They cannot broaden the run's tools or command policy. The run receives no credentials, unrelated host paths, conversation history, or authority to change persistent settings.
17. **Editing behavior:** when Ask AI succeeds, replace the message box with the suggestion and keep the modal open for review/editing. Disable Ask AI while it runs. A changed file selection invalidates neither user-written text nor a prior suggestion; the next Ask AI request always uses the current selection.
18. **Results:** successful Fetch, Pull, and Push may use a brief success toast. Successful Commit closes the commit modal and reports the short commit SHA/subject. Every action triggers a fresh Git status/branch refresh so the composer badge, Files/Changes surfaces, and title-bar state converge promptly.
19. **Error modal:** command failures open one reusable modal titled for the attempted action and display a renderer-safe, bounded version of Git's stderr (or stdout/fallback message). Preserve meaningful authentication, upstream, conflict, and rejection guidance, but omit stack traces, environment values, credentials, and unrelated absolute host paths. The text must be selectable/copyable.
20. **Human authority:** these direct UI actions do not go through agent approval policy because the user clicked the exact operation and confirms Commit in its modal. No equivalent mutating agent tools are added in this phase.

## Architecture

### Git operation service

Extend `GitService` or add a tightly coupled mutation service under `src/main/git/`. Keep all execution in the main process and continue using `Environment.execFile` with fixed Git argv, bounded output, timeouts, and `GIT_TERMINAL_PROMPT=0`. Network operations need a longer, explicit timeout than read-only inspection while remaining cancellable or bounded.

Use typed, renderer-safe results rather than collapsing expected Git failures to `null`:

```ts
type GitActionResult =
  | { ok: true; action: "fetch" | "pull" | "push"; summary: string }
  | { ok: false; action: "fetch" | "pull" | "push"; error: string }

type GitCommitResult =
  | { ok: true; sha: string; subject: string }
  | { ok: false; error: string }
```

Exact names may follow local conventions. Validate workspace presence and repository state in the main process on every call; renderer disabling is not a security boundary.

### File-selective commit transaction

Implement file-selective commit behavior behind one service call such as `commitSelected(paths, message)`. Do not expose generic `git add` or arbitrary argv over IPC.

The implementation must use Git's path-limited commit semantics (or an equivalently tested index transaction) so the resulting commit contains the selected working-tree snapshots while unrelated staged entries remain staged and unselected worktree changes remain untouched. Handle untracked selections explicitly. Treat rename source/destination pairs atomically. Snapshot enough index/status state to recover from validation or commit failure; never run reset/clean/checkout as a broad rollback.

Because Git index behavior is subtle, acceptance is test-driven rather than tied to one assumed command sequence. Integration tests against real temporary repositories must prove:

- selected tracked changes are committed and unselected tracked changes are not;
- a selected untracked file can be committed;
- selected deletions and renames produce the intended tree;
- unrelated staged changes remain staged after the selected commit;
- partially staged selected files commit the selected current file snapshot according to the modal's complete-file contract;
- an unselected staged file is not included;
- failed commits preserve the previous index and working tree; and
- conflicted paths are rejected without mutation.

Serialize operations per repository root, not merely per component instance, so two renderer entry points cannot race the Git index.

### Tool-enabled commit-message agent

Add a focused main-process module such as `src/main/git/commit-message.ts` that launches a restricted agent run rather than a plain completion. It should:

- validate the selected tracked/untracked paths against a fresh status before starting;
- construct a trusted request containing the repository workspace, exact selected path sets, JSON output schema, and an explicit instruction to ignore unselected changes;
- run the normal agent/tool loop without attaching it to the user's conversation transcript or durable task history;
- resolve the title-generation/default LLM selection and support the same provider and CLI targets as the normal agent path;
- expose `exec_command` with a run-specific read-only Git-inspection policy, workspace confinement, bounded command lifetime/output, and no approval escalation into broader commands;
- permit enough read-only commands to inspect status, staged and unstaged diffs, selected untracked files, and relevant recent context, while denying add/commit/reset/checkout/switch/restore/clean/stash/fetch/pull/push/config and non-Git mutation commands;
- cap model rounds/tool calls and total captured evidence so a large repository cannot create an unbounded hidden run;
- support cancellation when the user closes the modal, changes workspace, or requests generation again;
- parse strict JSON, optionally tolerating one fenced JSON object only if needed for provider/CLI compatibility;
- require exactly `commit_message: string`, reject extra keys and empty/oversized output; and
- return `{ commitMessage }` or a bounded user-facing error.

Do not give this hidden run a generic unrestricted shell merely because `exec_command` is present. The tool name and interaction should match the normal agent experience, but server-side policy must enforce the narrower read-only command capability. Repository output remains untrusted and cannot authorize additional tools or commands.

### IPC and renderer

Expose narrow methods under `window.cowork.git`, for example:

```ts
branches/status // existing or additive inspection methods
fetch(workspace)
pull(workspace)
push(workspace)
commit(workspace, paths, message)
generateCommitMessage(workspace, paths)
```

Register handlers near the existing Git handlers in `src/main/index.ts`. The preload types should import shared result types from the main Git module. Never send raw `Error` objects to the renderer.

Create a focused renderer component such as `src/renderer/src/components/git-actions.tsx` containing the title-bar trigger, action menu, commit modal, and error modal. `main.tsx` should pass the active `workspacePath` and receive or dispatch a lightweight `git-state-changed` notification after success. Keep this state out of `activity-panel.tsx` apart from moving/reusing the theme control if needed for layout.

The commit modal needs a fresh status on open; loading/empty/error states; separate Tracked and Untracked disclosure sections that both start expanded; per-section tri-state Select all/Clear controls and selected/total counts; accessible per-file checkboxes; readable status labels; a multiline commit-message field; Ask AI progress/error state; and a final Commit button. Section disclosure and selection must be independent, and keyboard/screen-reader users must receive expanded/collapsed and checked/indeterminate state. Prevent stale status or AI responses from one workspace from populating another after conversation/workspace changes.

## Implementation plan

### 1. Add typed Git action primitives

Extend the Git service with fetch, fast-forward-only pull, upstream push, repository-operation serialization, bounded errors, and suitable network timeouts. Add real-repository tests where local bare repositories can exercise successful fetch/pull/push without external network access, plus deterministic failure tests for detached HEAD, missing upstream, non-fast-forward pull/push, and command timeout/error sanitization.

### 2. Implement and prove file-selective commits

Add `commitSelected` with path/status validation, conflict rejection, untracked/rename handling, message validation, index preservation, and rollback for pre-commit failure. Build the real-Git matrix described above before wiring UI. Tests must inspect both the committed tree and post-operation index/worktree state.

Document hook behavior in the service: normal user Git hooks may run for a user-initiated commit/push unless the product explicitly disables them during implementation. Hook failure is surfaced and must leave state recoverable; no hook output is treated as trusted UI markup.

### 3. Build the restricted tool-enabled commit-message agent

Implement the hidden agent-run entry point, selected-path request envelope, dedicated read-only exec policy, tool/round/output budgets, provenance wrapping, provider routing, JSON-only prompt/example, cancellation, strict parsing, and safe errors. Test that the model can call `exec_command` to run allowed `git status`/`git diff` inspection, can inspect selected untracked files through an allowed bounded read-only command, and cannot run Git mutations, arbitrary shell mutations, network Git actions, configuration changes, or inspect unselected/out-of-workspace paths. Also cover clean JSON, fenced compatibility if supported, extra keys, missing/wrong types, empty/oversized messages, visible reasoning/preamble, binary/truncated/large evidence, provider failure, no configured provider, and stale/cancelled requests.

### 4. Add narrow IPC/preload methods

Register Git action and message-generation handlers in `src/main/index.ts`, with runtime input validation for workspace, path array, and message. Add exact preload types and renderer exports. Verify malformed payloads cannot inject flags, choose a remote URL, address paths outside the repository, or return host stack traces.

### 5. Build and place the title-bar Git control

Create the Git actions component and integrate it into `main.tsx` immediately to the right of the theme toggle. Refactor offset calculations so all title-bar controls remain clickable and non-overlapping with activity-panel resizing, Terminal, Activity, and native controls. Add repository detection/loading/disabled states and prevent duplicate concurrent actions.

### 6. Build the commit and error modals

Implement fresh changed-file loading and deterministic classification into Tracked and Untracked sections. Both sections start expanded, toggle independently, show selected/total counts, and provide tri-state group selection plus per-file selection; collapsing must preserve selection. Keep conflicted tracked entries visible but disabled and excluded from group Select all. Add multiline message validation, tool-enabled Ask AI progress/cancel behavior, commit progress, success handling, and stale-workspace cancellation. Use the shared Dialog/Button/Input primitives and the app's toast conventions. Add the shared selectable error modal for Fetch/Pull/Push/Commit and an inline AI error that does not erase the message.

### 7. Refresh dependent Git UI

After successful actions, trigger an immediate branch/status refresh rather than waiting for `App.tsx`'s interval. Prefer one typed renderer event or lifted refresh token over adding another polling loop. Confirm Files live refresh and Changes previews do not retain stale content after pull/commit where their existing watcher contracts can notify them; do not expand this phase into a new general repository state store unless integration proves it necessary.

### 8. Verify end to end

Run focused Git service, provider/parser, preload/IPC, and renderer tests, then `pnpm typecheck`, `pnpm test`, and `pnpm build`. Manually exercise clean/dirty/non-repo workspaces, tracked/untracked/deleted/renamed/conflicted files, existing unrelated staged work, provider failure/malformed AI output, no upstream, rejected push, non-fast-forward pull, authentication failure, activity panel open/closed, and workspace switching during an in-flight request.

## Acceptance criteria

- A compact Git actions button appears immediately to the right of the theme toggle for workspace-backed views without overlapping existing title-bar controls.
- Its menu offers Fetch, Pull, Commit, and Push, and prevents concurrent operations for the same repository.
- Fetch prunes the configured default remote; Pull is fast-forward-only; Push uses the current branch's existing upstream. No operation accepts arbitrary remote URLs or silently configures an upstream.
- Git/network failures produce a reusable modal with bounded, selectable, useful error text and no raw stack/credential leakage.
- Commit opens a modal with fresh Tracked and Untracked sections. Both start expanded, collapse independently without changing selection, show selected/total state, provide group-level Select all/Clear behavior, and retain explicit per-file selection; conflicts are visible but disabled.
- A commit contains exactly the selected complete-file changes. Unselected worktree changes and unrelated pre-existing staged changes survive and are not included.
- Empty selection/message, invalid paths, conflicts, detached/no-repository states, and failed commits are handled without unintended repository mutation.
- Ask AI starts an isolated, tool-enabled agent run in the workspace with `exec_command` available, inspects only the currently selected prospective commit, asks for `{"commit_message":"..."}`, validates the response, and populates—never submits—the editable message field.
- The hidden agent's exec capability is server-side restricted to bounded read-only repository inspection. It cannot mutate files/Git state, access out-of-workspace paths, perform network Git actions, broaden its tools, or alter persistent settings.
- Tool rounds, command/model input, captured repository evidence, and final output are bounded; command output and repository text are treated as untrusted data.
- Successful operations promptly refresh branch/status-dependent UI.
- Existing read-only Git tools, Changes/Files panels, Terminal control, theme toggle, Activity control, and composer behavior retain their existing behavior.

## Likely files

- Modify: `src/main/git/service.ts`
- Modify: `src/main/git/service.test.ts`
- Create: `src/main/git/commit-message.ts`
- Create: `src/main/git/commit-message.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/types.ts`
- Create: `src/renderer/src/components/git-actions.tsx`
- Create: focused renderer tests/helpers adjacent to `git-actions.tsx`
- Modify: `src/renderer/src/main.tsx`
- Possibly modify: `src/renderer/src/components/activity-panel.tsx` to make title-bar theme/Git layout composable
- Possibly modify: Files/Changes refresh integration if existing events do not cover Git mutations

## Out of scope

- A general staging area, hunk/line selection, amend, sign-off, commit signing UI, commit history, tags, stash, restore, reset, clean, merge, rebase, cherry-pick, force push, remote management, or credential entry.
- Automatically resolving conflicts, choosing pull strategy, setting upstreams, or retrying with destructive flags.
- Agent-callable Git mutation tools or bypassing normal agent action policy.
- AI-generated code changes, AI-selected files, unrestricted shell access, automatic commit submission, or adding the hidden agent run to conversation/task history.
- Background/scheduled synchronization or multiple simultaneous Git operations.
