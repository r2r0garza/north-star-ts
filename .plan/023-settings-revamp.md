# PR23: Settings revamp — full-screen takeover instead of the right slide-out sheet

> Status: **NOT STARTED**. UI-only (renderer). No backend, no IPC, no schema change — the same
> `window.cowork.settings.*` / `providers.*` / `models.*` surface is reused verbatim.

## Context

Settings currently live in a **right-side slide-out `Sheet`** capped at `w-[28rem] sm:max-w-md`
(~448px) — `settings-sheet.tsx:181`. Six tabs (Providers, Models, Backend, Permissions, Indexing,
Sandbox) plus an onboarding dialog are crammed into that narrow column. Providers/Models in particular
(collapsible account cards, API-key fields, per-account model lists, inline add/import forms —
`llm-settings.tsx`) are cramped and hard to use at that width, and the tab strip is getting crowded as
sections accumulate. It's the daily friction the user called out ("driving me crazy").

**Goal:** replace the narrow right sheet with a **full-screen takeover** — the settings fill the app
window with a **left nav rail** (the six sections as a vertical list) and a **wide content area**,
matching the mental model of VS Code / macOS System Settings. Everything gets room to breathe.

**Approach (decided): reuse content, swap the container.** Keep every tab's content component exactly
as-is (Providers/Models/Backend/Permissions/Indexing/Sandbox bodies); only replace the `Sheet` wrapper
+ the horizontal `TabsList` with a full-screen shell + a vertical nav rail. Lowest-risk path — this is
purely the layout fix, not a content redesign. Content polish for the new width is explicitly deferred
(see Out of scope).

## Current shape (what exists)

- **`settings-sheet.tsx`** — the container. `<Sheet><SheetContent side="right" …>` wraps a
  `<Tabs defaultValue={initialTab}>` with a horizontal `<TabsList>` of six `<TabsTrigger>`s and the six
  `<TabsContent>` bodies (Backend/Permissions/Indexing/Sandbox inline here; Providers/Models delegated).
  Also owns: settings loading (`getExecution`/`getPermissions`/`getIndexing`/`checkRuntimes`), save
  handlers, the `isContainer` gate for the Sandbox tab, and the sandbox **onboarding `Dialog`**
  (`settings-sheet.tsx:420`+).
- **`llm-settings.tsx`** — `ProvidersTab` + `ModelsTab` (+ `ModelRow`, add/import forms). These are
  `<TabsContent>` bodies today; they stay unchanged.
- **`main.tsx`** (`Shell`) — owns `settingsOpen` + `settingsTab` state, renders `<SettingsSheet
  open onOpenChange initialTab>` as a sibling of `App`/`ActivityPanel` inside `SidebarProvider`
  (`main.tsx:158`). `openSettings(tab?)` sets both. Trigger: gear icon in `AppSidebar`
  (`sidebar.tsx:264`); also opened from the composer's "Configure model…" → `onOpenSettings("providers")`
  (`App.tsx:709`).
- **UI primitives** (`components/ui/`): `sheet.tsx`, `dialog.tsx`, `tabs.tsx` (Radix + Tailwind).
  `Tabs` supports vertical orientation. `Sheet`/`Dialog` are the same Radix `Dialog` primitive with
  different positioning/animation classes.

## Plan

### 1. New full-screen container (`settings-screen.tsx`, replacing the sheet wrapper)

Rename/rework `settings-sheet.tsx` into a full-screen overlay. Two viable mounts — **prefer a
full-viewport `Dialog`** (reuses the Radix focus-trap, `Escape`-to-close, portal, and `open`/`onOpenChange`
API already wired) styled to fill the window, over a hand-rolled fixed div:

- `<Dialog open onOpenChange>` → `<DialogContent>` with classes overriding the centered-modal defaults
  to **fill the viewport** (`fixed inset-0 h-screen w-screen max-w-none rounded-none` — drop the
  `top-1/2 left-1/2 -translate-*` centering and the zoom animation; a fade or slide is fine).
- Keep the existing close **[X]** button (top-right), with the same `[-webkit-app-region:no-drag]`
  fix the sheet uses (`sheet.tsx:78`) so it's clickable under the macOS drag bar. Respect the app's
  top drag region (`main.tsx` top bar, `h-11`): pad the header so the title/close clear the traffic
  lights, or keep the takeover below the drag bar.
- Internal layout: a header row (title "Settings" + close), then a two-column flex — **left nav rail**
  (~14–16rem, vertical list) + **content area** (`flex-1`, scrollable, comfortable max-width like
  `max-w-2xl`/`3xl` so forms don't stretch edge-to-edge on a wide monitor).

### 2. Vertical nav rail (replace the horizontal `TabsList`)

Use `Tabs` in **vertical orientation** (`orientation="vertical"`) so section switching keeps Radix's
selected-state + keyboard nav for free — the six `TabsContent` bodies are reused unchanged. The
`TabsList` becomes the left rail (stacked `TabsTrigger`s, left-aligned); `TabsContent` renders in the
right column. The Sandbox trigger keeps its `disabled={!isContainer}` gate.
(If `Tabs` vertical styling proves fiddly, fall back to a plain `useState` section selector driving
which body renders — but try vertical `Tabs` first to preserve a11y wiring.)

### 3. Rewire the mount + state (`main.tsx`, minimal)

- `settingsOpen` / `settingsTab` state and `openSettings(tab?)` stay as-is — the takeover consumes the
  same `open` / `onOpenChange` / `initialTab` props, so `main.tsx:158` changes only the component name
  (`<SettingsSheet>` → `<SettingsScreen>`), and every existing open path (gear icon, composer
  "Configure model…") works untouched.
- `initialTab` still selects the starting section (now the initially-active rail item).

### 4. Keep the onboarding dialog as a nested `Dialog`

The sandbox onboarding prompt (`settings-sheet.tsx:420`+) stays a small centered `Dialog`, now
rendered inside/above the takeover. Verify a Dialog-over-fullscreen-Dialog stacks/focus-traps
correctly (Radix supports nested dialogs; if z-index/focus fights, render onboarding as a sibling
keyed off the same state).

## Likely files

- `src/renderer/src/components/settings-sheet.tsx` → **rename to `settings-screen.tsx`**; swap
  `Sheet`→full-screen `Dialog`, horizontal→vertical nav. Content/handlers/loading logic largely intact.
- `src/renderer/src/main.tsx` — update the import + JSX tag at `~:158`; state unchanged.
- `src/renderer/src/components/llm-settings.tsx` — **no change** (its tabs are reused as-is).
- `src/renderer/src/components/ui/` — reuse `dialog.tsx` + `tabs.tsx`; no primitive changes expected
  (all overrides via `className`). Only touch a primitive if a full-screen variant is cleaner as a
  reusable prop.
- `src/renderer/src/App.tsx`, `sidebar.tsx` — **no change** (open paths call `onOpenSettings` /
  `openSettings`, which are preserved).

## Open questions to resolve BEFORE/DURING building

1. **Takeover extent vs. the drag bar.** Cover the *entire* window (including behind the `h-11` top
   drag region, with padded header), or start *below* the drag bar so the traffic lights/toggles stay
   live? Leaning: full cover with a no-drag header, matching how the current sheet already overlays.
2. **`Dialog` full-screen vs. bespoke overlay.** Confirm overriding `DialogContent`'s centering classes
   cleanly yields a full-viewport panel (vs. adding a `variant`/`fullScreen` prop to the primitive).
   Prefer className overrides; escalate to a primitive prop only if the class list gets unwieldy.
3. **Animation.** Slide-up, fade, or none? Keep it subtle; avoid the modal zoom which looks wrong at
   full size.
4. **Nav rail content beyond sections.** Room now exists for a footer (app version, links) or grouping
   headers in the rail — nice-to-have, not required. Defer unless trivial.

## Verification (when built)

- **Manual (real app), all open paths:** gear icon in the sidebar and the composer's "Configure
  model…" both open the full-screen takeover, the latter landing on **Providers** (`initialTab`
  honored). `Escape` and the **[X]** close it; focus returns sensibly.
- **Every section renders and functions** at the new width: Providers (add/expand account, set/clear
  API key, default select), Models (list/add/rename/delete, import from gateway), Backend (Local/
  Docker/Podman with availability gating), Permissions + Indexing toggles persist, Sandbox tab enabled
  only under a container backend and its category switches work. All writes hit the same IPC and
  survive a reopen.
- **Onboarding dialog** still appears on the first switch to Docker/Podman and its Enable/Not-now
  resolves correctly over the takeover.
- **macOS chrome:** the close button and any controls under the top drag region are clickable
  (`no-drag`); traffic lights unaffected.
- `pnpm typecheck` + `pnpm build` clean. (Settings UI has little/no unit coverage today; this is a
  presentational change verified manually — no new tests required, but keep any existing green.)

## Out of scope

- **Backend / IPC / schema changes** — none; the revamp reads/writes the exact same channels.
- **Content redesign within sections** — reflowing/regrouping forms for the new width is a *later*
  polish pass; this PR swaps the container and reuses the bodies verbatim.
- **New settings** — no new toggles/sections added here; purely relocating what exists.
- **Removing the `Sheet` primitive** — other features may use it; leave `ui/sheet.tsx` in place even
  after settings stops using it.
