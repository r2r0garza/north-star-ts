# 001 — Chat UI & composer

**Area:** Renderer — `src/renderer/src/App.tsx`
**Status:** Implemented

## What

Replaced the original basic form (workspace path text field + message box +
read-only response box) with a proper chat interface:

- A scrollable conversation of chat bubbles — user messages right-aligned
  (primary color), assistant messages left-aligned (muted).
- A composer pinned to the bottom: a textarea that defaults to 2 rows, grows
  with content up to 16 lines (`field-sizing-content` + `max-h-[24.25rem]`),
  then scrolls. **Enter** sends; **Shift+Enter** inserts a newline.
- The workspace path text field was removed. A folder icon under the composer
  opens the native picker; once chosen, only the **last path segment** is shown
  (e.g. `/Users/me/perficient` → `perficient`).
- A round send button (↑), disabled until there's both a message and a selected
  workspace.

### Auto-scroll behavior
- The conversation follows new content **only while the user is pinned to the
  bottom** (within 80px). Scrolling up cancels auto-scroll so the user can read;
  scrolling back down re-engages it. Sending a message also re-engages it.
- A floating "scroll to bottom" button (↓) appears when the user is not at the
  bottom.

### Layout
- Root is `h-svh` + `overflow-hidden`; the conversation is `min-h-0 flex-1
  overflow-y-auto`. This makes the conversation div the actual scroller.
- Width is fluid: `max-w-[min(90%,72rem)]` on both the conversation and the
  composer (kept in sync so the input aligns with the messages).

## Why

- A chat bubble layout matches user expectations for an agent and reads far
  better than a static request/response form.
- Bottom-pinned composer is the standard chat affordance.
- Auto-scroll that the user can cancel avoids the common annoyance of being
  yanked to the bottom while trying to read earlier output mid-stream.

## Trade-offs / notes

- **Layout bug found & fixed:** the root was originally `min-h-svh` (grows with
  content), so the whole window scrolled and the inner `overflow-y-auto` never
  engaged — auto-scroll did nothing and the jump-to-bottom button never showed.
  Fixed by pinning the root to `h-svh`/`overflow-hidden` and adding `min-h-0` to
  the scroller.
- **Fluid width** chosen over a fixed cap so the chat doesn't sit in a narrow
  column on large/fullscreen windows, while `72rem` keeps line lengths readable.
- Send requires a workspace (the `chat` IPC contract needs one).
