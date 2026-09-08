# PR62: Structured read-only Git inspection tools

> Status: **DONE**. Implemented by `a911b1a` with a shared read-only Git service and
> `git_status`, `git_diff`, `git_log`, `git_show`, and `git_branches` tools plus
> Local/container support and tests.

## Goal

Add workspace-confined, read-only tools:

- `git_status`
- `git_diff(path?, staged?, base?)`
- `git_log(limit?, path?)`
- `git_show(revision, path?)`
- `git_branches`

## Design

Create one main-process `GitService` shared by agent tools and existing Changes UI
helpers. Resolve the repository root from the workspace, including subdirectory
workspaces, worktrees, submodules, detached HEAD, and `.git` pointer files.

Use machine-readable, non-interactive Git invocations:

- porcelain v2 / NUL-delimited status
- no color, no pager, no external diff/textconv commands
- bounded log formats with explicit separators
- `--` before user-controlled paths
- strict revision validation so a revision cannot become a flag

Return structured records plus bounded unified diff text. Page/cap large results and
report truncation explicitly. Treat "not a Git repository" as a normal typed result.

Execution must be argv-safe. Add an Environment `execFile`/argv primitive or an
equivalent backend seam rather than concatenating model inputs into shell strings, so
the same tools work in Local and container runtimes.

## Policy

- These tools are read-only from North Star's perspective and get a distinct `git_read`
  category for exact external mapping.
- Repository hooks, filters, pagers, credential prompts, network access, and external
  diff drivers must not run.
- No tool accepts a remote URL.

## Verification

- Clean/dirty/staged/untracked/renamed/conflicted states; binary and huge diffs;
  branches, detached HEAD, worktrees, submodules, Unicode paths, and Windows.
- Malicious path/revision values cannot inject flags or shell syntax.
- No pager, prompt, hook, network, or external diff process is invoked.
- Local/container results are equivalent and bounded.

## Out of scope

- Add/restore/commit/branch creation/merge/rebase/push/fetch or any other mutation.
- Git hosting APIs; those should arrive through MCP/connectors.
