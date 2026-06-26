# 005 — Window chrome & sidebar

**Area:** Main + renderer — `src/main/index.ts`, `src/preload/index.ts`,
`src/renderer/src/main.tsx`, `src/renderer/src/components/sidebar-toggle.tsx`,
`src/renderer/src/components/sidebar.tsx`
**Status:** Implemented

## What

### Title bar removal
The OS title bar is removed so the sidebar and chat reach the top of the window.
- macOS: `titleBarStyle: "hiddenInset"` + `trafficLightPosition: {x:16,y:18}` —
  the traffic-light buttons float over the top-left (i.e. over the sidebar).
- Other platforms: `titleBarStyle: "hidden"`.

### Window drag region
With no OS title bar, a full-width drag bar lives in `Shell` (`main.tsx`):
`absolute top-0 h-11 [-webkit-app-region:drag]`. The user can drag the window by
this strip.

### Collapsible sidebar
- A single fixed toggle button (`sidebar-toggle.tsx`) collapses/expands the
  sidebar (shadcn `offcanvas` — slides fully away). The same button expands it.
- Positioned to the **right of the traffic lights** when windowed (`left-20`);
  shifts to the **left edge** in fullscreen (`left-4`) since the traffic lights
  are hidden then.
- Fullscreen state comes from the main process: `enter/leave-full-screen` events
  pushed over `window:fullscreen`, plus an `is-fullscreen` query on mount,
  exposed via the preload bridge (`isFullScreen`, `onFullScreenChange`).
- Bonus: shadcn's sidebar already ships a **Cmd/Ctrl+B** shortcut.

## Why

- A chromeless window with the sidebar reaching the top is a cleaner, more
  native-feeling desktop layout.
- The toggle's position is constant on screen whether the sidebar is open or
  collapsed, so it reads as part of the sidebar when open and over the content
  when collapsed.

## Trade-offs / notes

- **macOS drag-region gotcha (cost two debugging rounds):** a
  `-webkit-app-region: drag` element swallows mouse clicks at the OS compositor
  level. A `no-drag` control only "punches through" if it's a **descendant** of
  the drag region, not merely overlapping it.
  - First failure: the toggle was a separate floating element over the drag
    strip — clicks were eaten (keyboard shortcut still worked, which was the
    clue). Fixed by making the toggle a `no-drag` **child** of the Shell drag
    bar.
  - Second failure: collapse didn't work but expand did. The **`SidebarHeader`
    had its own `drag` region** (added when removing the title bar) sitting under
    the toggle when expanded; when collapsed it slid away so the click landed.
    Fixed by removing the header's drag region — dragging is handled solely by
    the Shell top bar.
- Fullscreen offsets (`left-4`) are tuned by eye; easy to nudge.
