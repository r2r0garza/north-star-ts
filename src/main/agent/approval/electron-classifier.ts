import type { ActionClassifier, ActionDecision, ToolAction } from "./types"

// Classifier for `electron` actions (plan 119). Launching a development app
// executes workspace code (main process, preload, dependencies) with the user's
// OS privileges and network access, so it is the protected explicit tier: no
// allowlist rule or sandbox category downgrades it. Auto mode, which is run-level
// user pre-approval, still approves it like any other explicit action.
// Interactions with an approved session: consequential targets explicit, the
// rest normal (rememberable per session via their session-scoped identity).
export class ElectronActionClassifier implements ActionClassifier {
  classify(action: ToolAction): ActionDecision | null {
    if (action.kind !== "electron") return null
    if (action.tool === "electron_interact" || action.tool === "electron_run") {
      // Launch approval is not blanket authority over what the app can do.
      return action.detail?.interactionKind === "consequential_commit"
        ? {
            level: "require_explicit_approval",
            reason: "App action may commit a change (delete, send, submit…)",
          }
        : {
            level: "require_approval",
            reason: "Interacting with a launched test app",
          }
    }
    return {
      level: "require_explicit_approval",
      reason: "Launching an app runs its code with your user privileges",
    }
  }
}
