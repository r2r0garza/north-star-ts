# PR61: Granular filesystem lifecycle tools

> Status: **NOT STARTED**. Replaces common shell-only file management with confined,
> individually permissioned operations.

## Context

North Star can read, edit, write, patch, and list files. Creating directories,
renaming/moving paths, inspecting metadata, and deleting paths usually requires
`exec_command`, even though the Environment already exposes several underlying
primitives. That forces narrow external agents to receive an unnecessarily broad shell
or fail simple tasks.

## Goal

Add:

- `stat_path(path)` — type, size, revision where available, and safe metadata.
- `create_directory(path, parents?)`
- `move_path(from, to, overwrite=false)`
- `delete_path(path, recursive=false)`

All operations remain workspace-confined and work through Local and container
Environments.

## Safety contract

- Resolve every model path through the Environment; never accept absolute host paths.
- Refuse workspace root deletion/move and protected runtime/control paths.
- `move_path` is no-replace by default. Overwrite is explicit and separately gated.
- `delete_path` is non-recursive by default. Recursive directory deletion requires an
  explicit argument, an exact resolved target, and human approval.
- Return structured before/after facts and a clear no-op/missing/conflict result.
- Do not follow final-component symlinks; retain existing parent-symlink protections
  and remain compatible with `055`'s future openat hardening.
- Never implement these tools by interpolating paths into a shell command.

## Environment changes

Promote precise backend primitives as needed:

- `mkdir` distinct from `mkdirp`
- typed path metadata
- no-replace rename/install for files and directories
- non-recursive remove and explicit recursive tree removal

Local and Container implementations must have matching collision, symlink, and error
semantics. Container operations should use argv-safe/native primitives rather than
shell text where possible.

## Capability mapping

- GitHub `edit/createDirectory` -> `create_directory`.
- GitHub/VS Code rename operations -> `move_path` only when the source granted that
  exact operation.
- File deletion receives its own `delete` capability/effect; do not hide it under a
  broad edit grant unless the source group explicitly includes deletion.
- `stat_path` may be read-authorized; mutations never inherit the external-agent read
  floor removed by `057`.

## Verification

- File/dir create, move, collision, missing source, overwrite, empty/non-empty delete,
  recursive delete, symlinks, Unicode, Windows separators, and container parity.
- Approval classification distinguishes mkdir/move/delete and cannot be bypassed by a
  misleading filename.
- Workspace root, foreign paths, traversal, and protected paths fail closed.
- Stop during a recursive operation leaves a reported partial state and never escapes
  confinement.

## Out of scope

- Copying whole trees, chmod/chown, ACLs, trash integration, or arbitrary glob deletes.
- Treating `055` as complete; this plan must use its helper automatically when shipped.

