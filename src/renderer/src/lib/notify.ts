import type { NotificationSettings } from "../../../main/settings/service"

// Renderer-side desktop-notification gate. Main shows the OS notification; the
// renderer decides WHETHER to, because only it knows two things main doesn't:
// which conversation is currently on screen, and (via document.hasFocus) whether
// the app window is focused.
//
// Fire rule (per the user's spec): notify when the app is NOT focused, OR when it
// is focused but the target conversation is NOT the one being viewed. Equivalently
// suppress only when the window is focused AND you're already looking at the
// conversation the notification is about — in that case you can already see it.

export type NotifyKind =
  | "needsInput"
  | "turnComplete"
  | "turnError"
  | "taskComplete"

// Maps each notify kind to its per-event settings flag. `enabled` (the master
// switch) is checked separately.
const KIND_FLAG: Record<NotifyKind, keyof NotificationSettings> = {
  needsInput: "onNeedsInput",
  turnComplete: "onTurnComplete",
  turnError: "onTurnError",
  taskComplete: "onTaskComplete",
}

// In-memory copy of the persisted settings, so the hot path (every turn end)
// doesn't await IPC. Loaded on first use and refreshed when the Settings sheet
// closes (see refreshNotificationSettings). Undefined until first load → treated
// as "not yet known", so we fetch before the first decision.
let cached: NotificationSettings | undefined
let loading: Promise<NotificationSettings> | undefined

async function load(): Promise<NotificationSettings> {
  if (cached) return cached
  if (!loading) {
    loading = window.cowork.settings
      .getNotifications()
      .then((s) => {
        cached = s
        return s
      })
      .finally(() => {
        loading = undefined
      })
  }
  return loading
}

// Re-read settings from main (call after the Settings sheet closes so a change
// takes effect without a reload).
export function refreshNotificationSettings(): void {
  cached = undefined
  void load()
}

export interface NotifyInput {
  kind: NotifyKind
  title: string
  body: string
  // The conversation this notification is about. Clicking the OS notification
  // switches to it; also used to decide suppression (is it the on-screen one?).
  conversationId?: string
  // Whether that conversation is the one currently displayed. When true AND the
  // window is focused, the notification is suppressed.
  isViewing: boolean
}

// Fire a desktop notification if the settings and focus/view rules allow it.
// Safe to call unconditionally from event handlers — it self-gates.
export async function maybeNotify(input: NotifyInput): Promise<void> {
  const settings = await load()
  if (!settings.enabled) return
  if (!settings[KIND_FLAG[input.kind]]) return

  // Suppress only when the window is focused AND we're viewing this very
  // conversation — nothing to alert about, it's already in front of the user.
  const focused = typeof document !== "undefined" && document.hasFocus()
  if (focused && input.isViewing) return

  window.cowork.showNotification({
    title: input.title,
    body: input.body,
    conversationId: input.conversationId,
  })
}
