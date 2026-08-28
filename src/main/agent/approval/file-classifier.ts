import type { ActionClassifier, ActionDecision, ToolAction } from "./types"

// The permission policy for file actions, read live at classify() time. "auto"
// allows outright; "require_approval" routes through the human gate. Supplied as
// a getter (not a value) so a settings change takes effect on the next action
// without rebuilding the PolicyEngine.
export type FilePermissions = {
  file_write: "auto" | "require_approval"
  file_edit: "auto" | "require_approval"
}

// Classifier for file actions (write_file_tool, edit_file_tool). These are
// already confined to the workspace by the tools' path resolver. The policy is
// settings-driven: it reads the current permission for the action kind at
// decision time, so flipping "require approval to edit files" in Settings takes
// effect immediately — no restart, no pipeline change. A required approval is
// tagged category "workspace_mutation" so a sandbox may auto-approve it.
//
// Defaults to auto-allow when no getter is supplied (e.g. unit tests that don't
// wire settings), preserving the pre-settings behavior.
export class FileActionClassifier implements ActionClassifier {
  constructor(private readonly getPermissions?: () => FilePermissions) {}

  classify(action: ToolAction): ActionDecision | null {
    if (
      action.kind !== "file_write" &&
      action.kind !== "file_edit" &&
      action.kind !== "file_mkdir" &&
      action.kind !== "file_move" &&
      action.kind !== "file_delete"
    ) {
      return null
    }
    if (action.kind === "file_delete" && action.detail?.recursive === true) {
      return {
        level: "require_approval",
        reason: "recursive file_delete requires approval",
        category: "destructive_fs",
      }
    }
    if (
      action.kind === "file_mkdir" ||
      action.kind === "file_move" ||
      action.kind === "file_delete"
    ) {
      return { level: "allow" }
    }
    const policy = this.getPermissions?.()[action.kind] ?? "auto"
    if (policy === "require_approval") {
      return {
        level: "require_approval",
        reason: `${action.kind} requires approval (settings)`,
        category: "workspace_mutation",
      }
    }
    return { level: "allow" }
  }
}
