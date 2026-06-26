import type { ActionClassifier, ActionDecision, ToolAction } from "./types"

// Classifier for file actions (write_file_tool, edit_file_tool). These are
// already confined to the workspace by the tools' path resolver, so the PR2
// default is to auto-allow.
//
// This class is the SEAM where future file-write gating slots in (e.g. require
// approval for overwriting an existing file, or writing outside a subtree)
// WITHOUT touching the tools or the pipeline — flip the return value here and
// the same inline approval card fires for file writes, exactly as it does for
// shell. That is the whole point of routing every tool through one pipeline.
export class FileActionClassifier implements ActionClassifier {
  classify(action: ToolAction): ActionDecision | null {
    if (action.kind !== "file_write" && action.kind !== "file_edit") return null
    return { level: "allow" }
  }
}
