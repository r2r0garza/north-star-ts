// How far an approval's "remember" reaches. Shared by main (persisting the
// allowlist rule) and the renderer (which buttons an approval card offers).
//   workspace    — this exact action, in every conversation in this folder
//   conversation — this exact action, in this conversation only
//   kind         — EVERY action of this kind, in this conversation only. For a
//                  background task that conversation is the task's private
//                  worker transcript, so the grant covers exactly that run
//                  (including a resume/retry) and nothing else.
//   file_changes — `kind` for EVERY kind-wide-eligible kind at once (creates,
//                  edits, folders), same conversation-only reach.
export type ApprovalRemember =
  | "workspace"
  | "conversation"
  | "kind"
  | "file_changes"

// The identity stored for a kind-wide rule. The allowlist honors it only at
// conversation scope (see action-allowlist findMatch).
export const KIND_WIDE_IDENTITY = "*"

// Action kinds that may be granted kind-wide: workspace file changes, which are
// confined to the workspace and recoverable. Shell, delete, move, network,
// browser, MCP, and delegation stay exact-match — a kind-wide grant there would
// approve arbitrary commands or irreversible effects. Protected
// (require_explicit_approval) and hard-blocked actions are never allowlisted at
// all, so sensitive paths still prompt even under a kind-wide grant.
const KIND_WIDE_LABELS: Record<string, string> = {
  file_write: "file creates & overwrites",
  file_edit: "file edits",
  file_mkdir: "folder creation",
}

export function allowsKindWide(kind: string | undefined): boolean {
  return !!kind && Object.hasOwn(KIND_WIDE_LABELS, kind)
}

// The kinds a "file_changes" grant covers: every kind-wide-eligible kind.
export const FILE_CHANGE_KINDS = Object.keys(KIND_WIDE_LABELS)

export function kindWideLabel(kind: string): string {
  return KIND_WIDE_LABELS[kind] ?? kind
}
