# PR67: Conversation-scoped workspace checkpoints and safe restore

> Status: **DEFERRED**. A reversible safety layer for autonomous edits; not a wrapper
> around destructive `git reset` and not a replacement for version control.

## Goal

Add:

- `checkpoint_create(label?)`
- `checkpoint_list`
- `checkpoint_diff(checkpoint_id, path?)`
- `checkpoint_restore(checkpoint_id, paths?, mode="safe")`

Checkpoints belong to a conversation + workspace and are unavailable across unrelated
sessions by default.

## Design

Store manifests and content-addressed blobs in North Star app data, not inside the
workspace and not as hidden Git commits. Capture only files changed/created/deleted by
the conversation since its baseline where attribution is available; otherwise require
an explicit bounded path set. Include binary files under strict size/total caps.

Every manifest records path, type, revision/hash, existence, size, and blob reference.
Restore is conflict-aware:

- `safe` restores only when the current path still matches the expected post-checkpoint
  revision or is otherwise unambiguous.
- Conflicts are reported per path and never overwritten silently.
- Restore previews affected create/replace/delete operations and requires approval.
- Workspace root, foreign paths, symlink escapes, and broad unresolved globs are
  forbidden.

Use Environment primitives and `047` revision semantics. Never run `git reset`,
`checkout`, or `clean`; preserve the user's unrelated dirty work.

## Lifecycle

- Quota and retention settings; transactional manifest publication after all blobs are
  durable.
- Garbage-collect unreachable blobs safely.
- Deleted conversations/workspaces follow an explicit retention policy rather than
  leaving unbounded data.
- Stop/crash during capture or restore produces a recoverable journal/result.

## Verification

- Tracked/untracked/binary/deleted/renamed files, user edits after checkpoint,
  conflicts, partial restores, quota exhaustion, crash recovery, symlinks, and
  Local/container parity.
- Restore never touches unrelated dirty files or invokes destructive Git operations.

## Out of scope

- Full workspace snapshots, cloud backup, branching/committing, or automatic restore
  without approval.

