# Workspace path containment mishandles dot-dot prefixes and realpath errors

> Status: **OPEN**
> Severity: **P3 — valid-path rejection and misleading validation**
> Area: workspace path resolution

## Problem

Lexical containment uses `relativePath.startsWith("..")`. This rejects valid
names such as `..cache` or `..notes` that are inside the workspace. The same
pattern appears in a local containment helper.

`resolveInWorkspaceReal` also treats every `realpath` error other than its own
escape message as though the path did not exist. Permission errors, symlink
loops, invalid components, and I/O failures cause an ancestor walk instead of an
accurate fail-closed result.

## Reproduction test

Resolve existing and new in-workspace paths whose components begin with two dots
and assert they remain allowed. Inject `ENOENT`, `EACCES`, `ELOOP`, and generic I/O
errors from `realpath`; only `ENOENT` may walk to the parent. Retain symlink escape
and cross-platform separator coverage.

## Fix direction

Define parent traversal as `rel === ".."` or
`rel.startsWith(".." + path.sep)`, while continuing to reject absolute relative
results. Narrow the ancestor-walk catch to errors whose code is exactly `ENOENT`;
propagate or wrap every other validation failure.

## Acceptance criteria

- Valid in-workspace dot-dot-prefixed names are accepted.
- True parent traversal and absolute escape remain rejected.
- Only missing-path errors trigger nearest-existing-ancestor validation.
- Permission, symlink-loop, and I/O errors fail closed with accurate diagnostics.
