# PR119: Electron development-app launch and control for the coding agent

> Status: **IMPLEMENTED (2026-10-23) — all phases done; qualified on macOS (arm64) for development targets; controlled by Settings → Browser → "Let the agent launch Electron apps" (default on since 2026-10-23; replaced the `COWORK_ELECTRON_APPS` env flag). Windows/Linux not yet qualified.** Drafted 2026-10-21. This document proposes a capability; it does not authorize launching apps, installing dependencies, or implementing the tools.

## Objective

Give North Star's coding agent a first-class capability to launch a workspace-backed Electron application under development, inspect its windows, capture screenshots, interact with its UI, read bounded diagnostics, and stop it. Launching North Star itself from development sources in an isolated test instance is a primary acceptance case. Agents should not need to generate temporary Electron main-process scripts or drive an entire qualification session through `exec_command`. The capability supports two working modes over one session model (see [Working modes](#working-modes-exploratory-and-scripted-checks)): step-by-step exploration when the agent needs to look around, and host-run declarative checks when it needs fast, repeatable assertions.

This is a coding-agent development and verification capability, not general computer use or an Electron window embedded inside the agent browser. The target runs as a separate process with its own native windows. A successful component fixture is not evidence that the full application works. Bundled/packaged target launch and qualification are deferred to [PR120](120-bundled-electron-application-control.md), not prerequisites for this plan.

The user asked for a new launch capability, not implementation yet. This plan includes the minimum companion controls needed to make launch useful for testing; they share one managed application session rather than introducing a general desktop-control system.

## Current evidence and related work

`scripts/qualify-inline-artifacts-electron.mjs` builds a fixture using production renderer components, launches a visible `BrowserWindow`, and drives it with `webContents.executeJavaScript()`. It demonstrates real Electron rendering, but is neither a full North Star launch nor reliable native keyboard/pointer coverage. Preserve it as a regression fixture, not as the proposed product implementation. It runs about 20 checks in a few seconds because no model is in the loop: it polls DOM predicates every 25 ms and asserts in-process. A see-think-act agent pays a model round trip per step. That speed gap is the reason for the scripted mode below, and the reason that mode must not reintroduce arbitrary evaluation.

The existing agent browser has conversation-owned sessions, per-turn abortable handles, snapshot refs, image emission, bounded diagnostics and approval-aware tools. Relevant references are `src/main/browser/manager.ts`, `src/main/browser/session.ts`, `src/main/agent/tools/browser/`, `src/main/agent/tools/types.ts`, and `src/main/agent/approval/types.ts`. Its sessions belong to North Star; an external application's BrowserWindows cannot simply be added to that manager or reparented into its sidebar.

`package.json` currently includes Electron as a development dependency and does not declare Playwright. A packaged host cannot assume the development Electron executable, Node, pnpm, or Playwright is installed. Dependency/runtime resolution and packaging must be explicitly qualified, not implicitly downloaded during launch.

[PR112](112-app-run-recipes-and-acceptance-validation.md) covers app recipes and acceptance proof orchestration. This capability can supply its Electron runtime adapter later; it does not implement that orchestration or depend on planned PR112 code being present. [PR117](117-sandboxed-html-react-previews.md) is a separate untrusted-preview isolation problem, not an application automation backend.

## Scope and boundaries

Initial support is for agent-owned launches of an explicitly identified local Electron development app from a workspace, using a resolved development Electron runtime and explicit app entry. Include multiple target windows, navigation/reload invalidation, diagnostics, screenshots, deterministic cleanup and a human handoff. Start with workspace-backed local North Star mode; do not silently offer host execution to Chat without a workspace, remote/container workspaces, or unsupported provider bridges.

Bundled/packaged target executables, attaching to an already running personal app, controlling the live North Star host, arbitrary CDP endpoints/PIDs, general OS desktop automation, native menus/dialog automation, dependency installation, automatic app building and persistent unattended app services are out of scope. Native dialogs may require a handoff. Packaged target requests return a precise unsupported-capability error; they are deferred to PR120.

A target application executes code with the user's OS privileges. Its main process, preload, IPC and dependencies can access host resources. A new user-data directory prevents accidental profile reuse only when the target actually honors it; it is not a filesystem or network sandbox. Do not claim otherwise. Default tests must use controlled accounts/data and avoid real external mutations.

## Proposed model-facing contract

Use a dedicated `electron_*` family rather than overloading `browser_*`. Names and precise schemas are provisional until the backend spike, but the operations and authority boundaries are part of the design.

| Tool | Contract |
| --- | --- |
| `electron_launch` | Launch one approved development Electron runtime with an explicit workspace app entry, argument array and optional workspace-relative cwd. Packaged target mode is unsupported. Return host-owned `sessionId`, launch/profile status and current windows, or a bounded startup error. No shell command string. |
| `electron_status` | List this conversation's sessions or inspect one session's lifecycle, windows, selected target, exit information and bounded startup diagnostics. Must not launch or reconnect to arbitrary processes. |
| `electron_select_window` | Select an owned `windowId` obtained from status; return title, URL and new target generation. Never guess the first window when several are eligible. |
| `electron_snapshot` | Return a bounded accessibility-oriented outline with actionable refs scoped to session, window and document/snapshot generation. |
| `electron_screenshot` | Capture the selected application renderer via the existing validated image/media delivery pipeline, not a screenshot of unrelated desktop windows. |
| `electron_interact` | A discriminated schema for click, hover, drag, fill/type, select, key press and scroll. Ref-based pointer actions use the automation input pipeline, not DOM `.click()` masquerading as a pointer test. |
| `electron_wait` | Bounded waits for window lifecycle, document readiness, ref or locator visibility/absence, declarative conditions (see below) or URL changes, polled host-side. No arbitrary predicate code. |
| `electron_run` | Run a declarative check (an inline step list or a workspace check file) against an owned session in one call. Host-run at machine speed; stops at the first failed step and returns per-step results plus failure evidence. Same authority and approval as the single-step tools; no evaluation. |
| `electron_console` | Cursor-based bounded renderer console, application stdout/stderr and crash records, attributed to the correct session/window/source. |
| `electron_handoff` | Bring the target forward and pause for the user to complete login, native UI or other human-only steps. Resume with fresh window inventory and refs. |
| `electron_close` | Gracefully close an owned app session, then bounded escalation against only its verified owned processes. Report cleanup outcome. Idempotent. |

Every window operation supplies a `sessionId`; selection is session-local and conversation-owned. Returned refs are opaque and do not act as selectors in unrelated windows. A stale or detached target requires a fresh inventory/snapshot rather than fallback to another visible window. Discover the main UI, splash screens, settings windows and popups without treating every Chromium target as an eligible renderer.

Launch inputs are bounded and normalized. Validate executable identity, cwd, argument count/length, timeouts and supported modes before approval. Use a resolved development Electron executable plus an explicit workspace app entry; do not resolve installed application bundles or accept packaged target mode. Do not guess app arguments or run package scripts as a hidden launch step. Report missing builds/dependencies as actionable errors; build/install remains a separate approved operation.

Do not expose arbitrary main-process evaluation, Node evaluation, IPC invocation, preload installation, raw debugging protocol forwarding, unrestricted environment inheritance, or free-form JavaScript evaluation in the initial tools. If advanced evaluation is later justified, give it a separate design, permission and approval boundary; the browser's page-only guarantees do not transfer to Electron renderers with Node/preload access.

## Working modes: exploratory and scripted checks

Both modes use the same session, window, approval and action-classification model. The difference is who drives the loop.

**Exploratory mode** is for unknown apps, investigating a bug or finding out what to assert. The agent drives step by step with `electron_snapshot`, `electron_interact`, `electron_wait` and `electron_screenshot`, reading a fresh snapshot between decisions. It is slow (one model round trip per step) and that is acceptable. Snapshot refs are ephemeral and scoped to one observation.

**Scripted mode** is for asserting known behavior, re-checking a fix and regression runs. The agent writes a declarative check, a JSON step list, and runs it with `electron_run`. The host executes every step without returning to the model, polling waits and assertions every ~25–50 ms. The model reads one result at the end. Typical flow: explore until behavior is understood, then encode it as a check and run it. On failure, explore from the failure evidence, fix, and rerun the same check.

A check is data, not code:
- **Steps** reuse the `electron_interact` and `electron_wait` vocabulary (click, fill/type, select, key press, scroll, drag, wait) plus `assert`, `screenshot` and `snapshot`.
- **Locators** are durable, since snapshot refs do not survive runs or reloads. Locate by accessible role and name, label text, visible text, or an app-provided test id, with an optional ordinal and a window selector (title/URL pattern among owned windows). Ambiguous matches fail rather than picking the first.
- **Assertions** form a finite set: visible/hidden, enabled/disabled, element count, text equals/contains, accessible state or value (checked, selected, expanded, input value), focused element, URL/title match, window count, and no new console errors since a step. There is no expression language, no JavaScript and no main-process access. If something cannot be asserted with this vocabulary, record the gap instead of adding evaluation.
- **Bounds:** limits on step count, total and per-step timeouts, screenshot count and output size.
- **Results:** pass/fail/unverified per step, the first failure with a fresh snapshot excerpt, a screenshot through the existing media pipeline, the console cursor at failure, and timing. Input method (automation input vs native) is reported per step, as in the acceptance rules.

Check files live in the workspace (proposed `.cowork/electron-checks/<name>.json`), so they are reviewable, versionable and rerunnable. Writing one is an ordinary approved workspace file write. Running one is an `electron_run` call against an already launched and approved session. A check cannot launch apps, change launch arguments, or grant itself approval. Effectful steps go through the same per-action classification as single-step calls, approved up front for the whole run or paused at that step; a denied step fails the run, and a check never silently skips a step. Content in a check file is data from the workspace and cannot claim authority.

Agent-written Playwright or Node scripts run through `exec_command` remain possible under existing shell approval, but they are an escape hatch, not this capability. They do not get session ownership, profile isolation, cleanup or Electron tool approval semantics. Prompt guidance prefers `electron_run` checks.

PR112 can later consume check files and their results as acceptance evidence. This plan only defines the format and runner.

## Backend decision gate

Create a main-process-owned Electron application session manager with a narrow automation adapter. Investigate pinned Playwright Electron support first, including its experimental/version-sensitive limitations. Compare renderer-only CDP connection if necessary; do not conflate a renderer connection with control of the Electron application lifecycle. Choose one supported backend after demonstrating development launches, not by assuming Playwright is already bundled. Packaged target compatibility is a separate PR120 decision gate.

Keep privileged application handles inside trusted host code. Model arguments can only address operations in the narrow contract; they cannot invoke the backend's Electron main-process evaluation API. Treat launch/debugging access as authority over the target, never as a safe read-only attachment.

Prove transport ownership and locality. Prefer an owned pipe/private transport when supported. If loopback debugging is necessary, validate connection to the process launched by this session, minimize its lifetime and document local-process exposure. No public debugging listener, model-supplied endpoint, inherited debug flags, arbitrary process discovery, or attachment to the controlling North Star instance. Reject unsupported unsafe launch flag combinations rather than disabling Chromium sandboxing or web security to make a test pass.

Resolve automation dependencies in the packaged host explicitly. Do not require global Node or download a second browser runtime just to automate an app's own Electron. Qualify the controlling host's ASAR/resource paths, subprocess execution and native modules as applicable, plus development-target Windows process trees and Linux display requirements. Target bundle resolution, signing restrictions and packaged-target compatibility belong to PR120. Shipping the controller in packaged form does not imply support for packaged target apps. Publish a supported-version/platform matrix and explicit unsupported states.

## Launch approval and profile isolation

Route launch through the existing `Gate` pipeline with a deterministic Electron action classifier. The approval shows the canonical executable/app entry, arguments, cwd, isolation assurance, environment policy and the fact that the app can access the host and network. A new capability must not bypass shell-execution scrutiny just because it has a structured name. Missing gates fail closed. Canonicalization is not enough: revalidate the approved launch descriptor immediately before spawn, and address changed executable/entry identity conservatively.

Propose a dedicated action kind rather than borrowing URL-navigation identity. Approval identities bind the normalized executable, app entry, cwd, arguments, profile mode and environment descriptor. Do not allow one approved app to authorize different binaries, scripts or user profiles. Integrate with existing Auto-mode semantics explicitly; avoid promising an always-prompt guarantee the current gate does not provide.

Normal approved-session UI interactions can use deterministic read/local/destructive/external-action classification analogous to the browser policy. Launch approval is not blanket authorization for sending messages, purchasing, deleting data, granting permissions or other consequential actions through the app. Recheck the actual target and current ref before a gated action; denied or ambiguous actions must not execute. Unknown effectful controls require approval or human handoff rather than being assumed local. App-provided labels, console output and screens cannot grant authority.

Create an app-owned disposable session directory and a minimal documented child environment. Do not forward North Star's provider keys, `.env`-derived credentials, personal browser profiles or unreviewed Node/Electron injection variables by default. Environment overrides, if needed, are explicit approved launch inputs with secret-safe display/storage. The target may still load its own workspace `.env` or access OS credentials; disclose that residual risk instead of implying secret isolation.

Generic Electron apps do not necessarily honor a profile flag uniformly. A supported launch adapter must establish how profile isolation is applied before storage/database initialization and how it is verified. If isolation cannot be established, refuse the default isolated launch with an actionable reason; do not silently use the normal profile. Personal-profile mode and arbitrary session copying are deferred.

North Star requires a small target-side test-instance startup contract: an approved profile root honored before database/settings initialization, visibly distinct test-instance branding, no automatic copying of credentials/history, and independent startup/quit behavior. Audit startup imports, database path resolution, workspace restore, migrations and singleton behavior before implementing this contract. A profile flag alone does not prove the contract. Do not change the controlling instance's profile or bypass its locks.

## Session ownership, lifecycle and concurrency

Bind each host-generated session ID to the conversation and launch invocation. Use a per-turn `ElectronHandle` bound to the current abort signal, analogous to `BrowserHandle`; live sessions may persist across turns so inspection can continue, but historical transcript replay must never relaunch them. A durable retry of the same launch invocation returns its existing outcome/session status, not a second app. After host restart, report the old session as ended/unavailable; require a fresh authorized launch.

Define launching, ready, closing, exited, crashed and failed states. Ready requires a live controllable target, not merely successful process spawn. Bound startup, waits, screenshots, interactions and shutdown. Cancellation during startup tears down the partial launch. Stop cancels in-flight operations and prevents late clicks/results; an established idle session may remain available across turns, visibly owned and explicitly closable. Document this behavior in tool descriptions.

Serialize effectful operations per session and ensure a window selection cannot race an interaction. Invalidate refs on navigation, reload, window closure and replacement. Verify target identity again after asynchronous waits/approval. Closing or revoking a session cancels queued operations. Cap live sessions/windows, logs, captures and pending actions; propose two live apps per conversation initially, with configurable host-wide resource limits established during qualification.

On close, conversation deletion and host shutdown, release automation connections and owned resources. Escalate shutdown only against verified session-owned processes; never kill by name or stale PID. Define and test development child-process ownership rather than assuming parent exit stops a Vite server. Remove only app-created temporary directories after process exit; surface retained resources when cleanup fails. Include startup reconciliation for residual test processes/profiles after abnormal host termination without automatically attaching to or killing unrelated processes.

## Integration and user experience

Likely new modules are `src/main/electron-apps/` for ownership/adapter/lifecycle and `src/main/agent/tools/electron/` for validated tools. These are proposed paths, not existing implementations. Wire the manager in `src/main/index.ts` and inject an optional scoped handle into `ToolContext` through `src/main/agent/index.ts`; never import the app manager directly into tool modules.

Register the capability in `src/main/agent/tools/index.ts`, tool scheduling/effects, approval classification, provider definitions and explicit permission categories in `src/main/agent/agents/tool-categories.ts`. Add a dedicated `electron` category; existing `execute` or `browser` permission must not implicitly expand into application automation. Withhold it in plan/read-only contexts and unsupported runtimes. Audit native provider and CLI/MCP bridge context, cancellation, approval and image delivery separately before exposing the tools there. Return a truthful unavailable result when the bridge cannot support the contract.

Reuse validated screenshot persistence/delivery rather than returning base64 inside ordinary text. Attribute captures/logs to session, window and observation time; preserve the existing untrusted-data boundaries. Redact sensitive diagnostics and bound text/image output. Screenshot redaction cannot be assumed: clearly identify that a capture may contain the target app's visible sensitive data.

Show active app sessions with app identity, test-profile status, window count, running/crashed state and a host-owned stop control. Separate the real native application window from browser tabs and preview artifacts. Surface live state to the agent each turn so closed/crashed sessions are not described as open. User manual actions, navigation and window closure invalidate stale assumptions. Handoff suspends automated interaction until the user returns control.

Do not add a full QA dashboard or recipe editor in this PR. The initial visible session/stop surface and accurate activity titles are sufficient; PR112 can consume structured evidence later.

## Implementation phases

### Phase A: Runtime and isolation spike

Choose and pin the automation backend only after a small fixture and a full North Star dev instance demonstrate launch, window inventory, renderer snapshot/capture, real automation input and teardown. Establish North Star's test-profile startup contract. Record which flags/transports are required, privilege exposure, controller runtime/dependency constraints and the development-target OS/version support matrix. Verify no access to the controller window or default user profile. No production tool exposure until this gate passes.

**Phase A record (2026-10-23, macOS 26 / Darwin 25.6, Electron 37.10.3, dev target only).**

- **Backend: North Star's own CDP client over `--remote-debugging-pipe`** (fd 3 host→target, fd 4 target→host, NUL-delimited JSON). There's no TCP listener or port, and nothing to discover: only the spawning host holds the pipe. No Playwright dependency. No Node inspector, so main-process evaluation is not reachable. Verified: `Target.getTargets` window inventory, flattened `Target.attachToTarget`, `Accessibility.getFullAXTree`, `Page.captureScreenshot` (also of a hidden window), `Input.dispatchMouseEvent`, and `Browser.close` → exit code 0. Playwright Electron was not adopted. It connects through `--inspect` (main-process evaluation authority) plus a loopback debugging port, and it would add a dependency.
- **Generic profile flag:** Electron honors `--user-data-dir` for `userData`. `HOME` in the child env does **not** move `app.getPath("home")` on macOS, so a generic target can still write to the real home. The adapter must not claim home isolation for arbitrary apps.
- **North Star test-instance contract** ([test-instance.ts](../src/main/config/test-instance.ts), first import in `src/main/index.ts`): `--test-profile=<absolute dir>` sets `userData` → `<dir>/user-data` and `home` → `<dir>/home`, plus `HOME`/`USERPROFILE` for `os.homedir()` callers and children. This happens before any module resolves a path. A relative, empty or repeated value exits with code 2 (fails closed). The display name gains a "(Test instance)" suffix. No single-instance lock exists, so the test instance starts and quits on its own. Residual risk: `.env.local` is still read from the app path.
- **Qualification:** `node scripts/qualify-electron-test-instance.mjs` (after `pnpm build`) launches the real dev app with a minimal env (`PATH`, `LANG`). It finds the branded primary window (~6.4 s), takes an AX snapshot (156 nodes) and a PNG screenshot, quits with code 0, and checks that `processes.db` and `~/.processes/*` land in the temp profile. It also confirms nothing under the personal `userData`/`~/.<system>` dirs was modified. All 7 checks pass. Fresh-profile onboarding shows, which confirms no settings/history reuse.
- **Not yet qualified:** Windows/Linux, native input beyond CDP `Input.*`, multi-window/popups, and dev-server (`electron-vite dev`) child-process ownership.

### Phase B: Managed launch, ownership and diagnostics

Implement schemas, launch approval, profile/environment policy, session state machine, invocation retry behavior, bounded logs, status/windows, close and cleanup. Add cancellation, timeouts, owner checks and host lifecycle wiring. Provide host-owned stop visibility. Verify packaged dependency resolution before claiming the host can ship the feature.

**Phase B record (2026-10-23).** Opt-in via `COWORK_ELECTRON_APPS=1` in `.env.local`.

- **Manager** ([`src/main/electron-apps/`](../src/main/electron-apps/)):
  - Session states: launching → ready → closing → exited/crashed/failed. Ready means a page target exists over the pipe.
  - Each session has its own process group (POSIX `detached`) and a disposable profile under `<tmp>/<slug>-electron-apps/<hostPid>/`.
  - Child env is built from a passthrough list (PATH, locale, temp, display vars) plus `HOME` set to the profile home. Provider keys, `NODE_OPTIONS` and `ELECTRON_*` are never inherited.
  - Logs: last 200 stdout/stderr lines, each capped at 500 chars.
  - Limits: 2 live apps per conversation, 6 per host.
  - Invocation retry: a repeated `invocationId` returns its first session.
  - Ownership: sessions are bound to their conversation, and foreign ids are refused.
  - Window inventory: `Target.setDiscoverTargets` events, plus a refresh on every status read, because Chromium emits no event for a title-only change.
  - Teardown (idempotent): `Browser.close`, then SIGTERM, then SIGKILL to the session's own group, then a sweep of leftover group members, then profile removal. The cleanup outcome is reported.
  - A self-exited or crashed app is torn down immediately.
  - Lifecycle hooks: conversation deletion closes its apps; `will-quit` SIGTERMs owned groups synchronously; boot `reconcile()` removes profile dirs of dead host pids and never touches processes.
- **Launch validation** (`launch.ts`), run before approval and again before spawn:
  - The app entry and cwd must resolve, via real paths, inside the workspace.
  - Entry is an app directory whose `package.json` `main` exists (`missing_build` otherwise), or a .js/.cjs/.mjs main script.
  - Electron is the workspace's own `node_modules/electron`, found by reading `path.txt` as data, never by executing its JS (`electron_missing` otherwise).
  - Packaged bundles → `unsupported_packaged`.
  - Args: at most 32, each at most 1024 chars. Debugging, profile and sandbox-weakening flags → `unsafe_flag`.
  - A target whose package name equals the host's gets `--test-profile`; anything else gets `--user-data-dir`, and the approval discloses that home is not isolated.
  - If identity changes after approval → `approval_changed`, and nothing spawns.
  - Environment overrides are not accepted yet.
- **Approval:** new `electron` action kind, `ElectronActionClassifier`, explicit tier (no allowlist or sandbox downgrade; Auto mode approves it like other explicit actions). The card shows runtime, entry, args, cwd, profile mode, env policy and the host-privilege disclosure.
- **Tools:**
  - `electron_launch`: gated; returns JSON with an untrusted-data note.
  - `electron_status`: read-only.
  - `electron_close`: not gated, since it only closes the conversation's own apps.
  - All three sit in a new `electron` agent category.
  - They're offered only on live turns in a local, non-read-only workspace, outside plan mode.
  - Each turn adds a system-trust `electron_state` section with session id, state, entry and window count. App titles stay out of it.
- **Host stop surface:**
  - `electron-apps:list`/`stop`/`changed` IPC plus `window.cowork.electronApps`.
  - `ElectronAppsBar`: a floating strip shown only while an app is live, with entry, profile mode, window count, state and Stop. Not yet visually reviewed.
- **Tests:** launch validation, pipe codec, classifier tier, tool gating/retry/foreign/untrusted output, and `manager.live.test.ts`. The live test runs real Electron fixtures covering ready, retry, foreign session, changed approval, minimal env, child-process cleanup, crash, startup timeout, Stop during startup and the conversation limit. The full North Star test-instance launch/close (with DB in profile and exit code 0) runs with `ELECTRON_APPS_NORTH_STAR=1`.
- **Packaged host:** the controller needs no new dependency (Node `child_process` + pipe), so nothing extra ships. Running it from a packaged North Star is not yet qualified.
- **Not done or unqualified:**
  - Windows process-tree kill (main process only; marked `shortcut:`).
  - Linux display.
  - Environment overrides.
  - Native/CLI bridge exposure (not offered there).

### Phase C: Renderer inspection and interaction

Add selected-window snapshots, stale-safe refs, screenshot media emission, discriminated interactions, waits and handoff. Integrate action approval and per-session scheduling. Test actual input behavior separately from DOM state manipulation. Do not silently add JavaScript evaluation to compensate for missing interactions.

**Phase C record (2026-10-23).** Still behind `COWORK_ELECTRON_APPS=1`.

- **[`WindowControl`](../src/main/electron-apps/window-control.ts)**, one per session, uses pure CDP over the session pipe:
  - Each window gets a flattened attach with `Page`/`DOM`/`Accessibility` enabled and `Emulation.setFocusEmulationEnabled`; without that, keyboard input to an unfocused or hidden window is silently dropped.
  - The snapshot is a bounded outline from `Accessibility.getFullAXTree` (40 KB, 300 refs) that shows states (focused/disabled/checked/expanded/selected/value).
  - Refs are opaque `s<snapshot>e<n>`. They go to interactive roles, plus *named* pointer-target roles (region, listitem, row, cell, img, note, group, dialog, tooltip, …) so hover and drag can reach tooltips and drop zones.
  - Refs die on a new snapshot, main-frame navigation (`Page.frameNavigated`), window destruction and reselection, each of which bumps a generation. Approved targets are re-verified against that generation before acting (`stale_ref`).
  - One window is chosen implicitly; with several, the call fails until `electron_select_window` is used (`window_ambiguous`).
- **Input:**
  - click, hover and drag: `DOM.getBoxModel` + `Input.dispatchMouseEvent`. The fixture's `isTrusted`-only handler proves real input.
  - fill: `selectAll` + `Input.insertText`.
  - type: per-character `Input.dispatchKeyEvent`.
  - press: a named key or a single character, with modifiers.
  - scroll: `mouseWheel`.
  - Native `<select>`: Electron draws its popup as an OS menu, so one fixed host-authored function sets the value. Results report `inputMethod: "dom-assisted-native-select"`.
  - The `load` wait evaluates the constant `document.readyState`.
  - No model-supplied script exists anywhere.
- **Screenshots:** JPEG via `Page.captureScreenshot` clipped to the visual viewport, scaled to at most 1280 px (device-scale aware), delivered through `emitImage` with session/window/time attribution.
- **Waits** (host-polled every 150 ms, at most 30 s): `load`, `text`/`text_gone` (accessible name/value), `ref_gone`, `url`/`title` contains, `window_count`.
- **Handoff:** `Target.activateTarget` + `Page.bringToFront`, then the turn pauses on `ask`. The session refuses automation (`handoff_active`) until the user returns; then refs are invalidated and the inventory refreshed. The handoff is released on cancel too.
- **Concurrency and Stop:**
  - Per-session serial queue, with ownership and `ready` checks.
  - The turn signal is checked before every CDP send, so a stopped turn sends no late input.
  - Refused for other conversations.
- **Tools:** `electron_select_window`, `electron_snapshot`, `electron_screenshot`, `electron_interact` (discriminated `action`), `electron_wait`, `electron_handoff`, all in the `electron` category.
- **Approval:** hover and scroll are not gated. Other input uses the `electron` kind:
  - **Consequential** (target or option matching the commit vocabulary shared with the browser, submitted fill/type, or Enter) → explicit tier, identity bound to session + action + target labels + payload hash.
  - **Everything else** → normal tier with identity `electron_interact:<sessionId>`, so "remember" covers only that one test app.
  - Approval summaries redact typed payloads.
  - Launch approval never authorizes consequential actions.
- **Qualification:**
  - `window-control.live.test.ts` runs a real hidden multi-window fixture covering trusted click, fill, type, native select, hover tooltip, pointer drag, modal + Escape, scroll, screenshot bounds, stale ref after re-snapshot, popup discovery + explicit selection, navigation invalidating an approved target, handoff refusal, Stop-before-input and foreign conversation.
  - The 13-step sequence takes **~2.1 s** host-side; stable over 3 runs.
  - Opt-in North Star (`ELECTRON_APPS_NORTH_STAR=1`) launches the real test instance, snapshots the first-run Settings dialog, closes it by click, fills the composer (never sent), screenshots and quits cleanly.
- **Not yet qualified:**
  - Native OS input, menus and dialogs (handoff covers them).
  - Renderer console capture (`electron_console`).
  - Custom (non-native) select helpers.
  - Renderer crash recovery within a live session.
  - Native-provider/CLI bridge exposure.

### Phase C2: Scripted checks

Add the declarative check schema and validator, durable locators, the finite assertion set and the host-side `electron_run` runner on top of Phase C operations. Cover run-level approval of effectful steps, stop-on-first-failure evidence, cancellation mid-run and bounds. Add workspace check files and prompt guidance for when to explore versus write a check. Measure end-to-end check speed against the equivalent exploratory sequence and record both.

**Phase C2 record (2026-10-23).** Still behind `COWORK_ELECTRON_APPS=1`.

- **Format and validator** ([`check-runner.ts`](../src/main/electron-apps/check-runner.ts)):
  - A check is `{name?, description?, timeoutMs?, stepTimeoutMs?, steps}`.
  - Steps: `click`, `hover`, `drag`, `fill`, `type`, `select`, `press`, `scroll`, `wait` (`until`), `assert` (`that`), `window` (title/url substring), `screenshot`, `snapshot`.
  - Locators: `{role?, name?, nameContains?, label?, text?, testId?, nth?}`. `testId` uses `DOM.querySelectorAll` on `[data-testid="…"]` with a charset-restricted value; the rest match accessibility role/name/value literally. Text runs resolve to their element, and several matches fail unless `nth` is given.
  - Conditions (exactly one): visible, hidden, enabled, disabled, focused, count, text equals/contains, state (checked/selected/expanded/pressed/value), url, title, windowCount, pageText, load.
  - Strict: unknown steps, fields or condition shapes are rejected (so `script`, `css` and `expression` fields cannot ride along), and all strings are literal.
  - Bounds: 64 KB JSON, 200 steps, 5 screenshots, 2 000-char strings, total timeout ≤ 300 s (default 60 s), per-step timeout ≤ 30 s (default 5 s).
- **Runner:**
  - Host-side under the session's serial lock, polling every 40 ms.
  - Actions auto-wait until their locator resolves to one visible element, then use the same `WindowControl.perform` input pipeline as `electron_interact`, with the input method reported per step.
  - Waits and assertions both retry until their timeout.
  - Stops at the first failure with per-step `pass/fail/not_run` and timings, the error, a fresh snapshot excerpt (4 KB) and a failure screenshot through the media pipeline.
  - Stop → `cancelled`.
  - A check cannot launch, change launch args, or touch any other session (it runs on an already-owned session).
- **`electron_run` tool** (`check` inline or a workspace `.json` `file`, resolved with `resolveInWorkspaceReal`):
  - Approval is up front for the whole run:
    - no effectful steps → no prompt;
    - reversible only → the normal tier with the same `electron_interact:<sessionId>` identity, so a remembered session grant covers it;
    - any statically consequential step → the explicit tier, bound to a hash of the check.
  - At run time, a step whose *resolved* target is consequential without that up-front coverage (e.g. a testId landing on "Delete") pauses for its own explicit approval.
  - A denied step fails the run and is never silently skipped.
- **Check files:** any workspace-relative `.json`. The plan's `.cowork/electron-checks/<name>.json` naming is a convention for the agent (described in the tool), not enforced.
- **Qualification** (`window-control.live.test.ts`, stable 3×):
  - A **21-step check runs in ~1.5 s** host-side, vs ~2.1 s for the 13-step exploratory sequence driven step by step from the test (with no model round trips; with a model, each exploratory step adds a full turn).
  - Pass/fail matches the exploratory sequence on the same fixture behaviors.
  - Also covered: first-failure evidence (snapshot + screenshot, later steps `not_run`), ambiguous locator, denied step not executed (counter unchanged), cancellation mid-wait.
  - Opt-in North Star runs a 4-assertion check against the real test instance.
- **Gaps:**
  - No "no new console errors since step" assertion: renderer console capture (`electron_console`) is not built yet.
  - No check-file editor or PR112 integration.

### Phase D: Capability exposure and end-to-end qualification

Wire explicit tool permissions, supported modes/providers, prompt guidance, context state and transcript representation. Qualify the full North Star development app and at least one independent Electron development fixture on supported platforms. Do not gate this coding-agent capability on packaged target support. Document unsupported native UI and apps that cannot establish isolated launch. Ship behind an opt-in feature flag until qualification passes; disable launch independently of historical evidence rendering.

**Phase D record (2026-10-23).**

- **Exposure audit:**
  - The tools are offered only on live API-provider turns (the native Claude-subscription provider included: it advertises an inventory, and calls come back through North Star's own loop, so approvals, cancellation and `emitImage` are unchanged).
  - Only in a local, non-read-only workspace, outside plan mode, with the flag on.
  - CLI runtimes (`claude_code`, `codex`) return before the handle exists, and the CLI MCP bridge lists browser tools only, so they never see `electron_*`.
  - The durable task runner has no live handle.
  - Custom agents need the `electron` category; `execute` and `browser` do not imply it. External agents follow their built-in policy.
  - A call to an un-offered `electron_*` tool gets the loop's existing unavailable result.
  - Turning the flag off only stops offering the tools: historical tool results stay ordinary transcript text, and the host Stop bar still controls any live session.
- **Guidance and context:** the per-turn `electron_state` section (emitted only when the tools are offered) carries the live session list plus usage guidance: use `electron_*` instead of Electron/Playwright scripts via `exec_command`, build first, explore and then encode an `electron_run` check, hand off native UI, packaged apps are unsupported, close unused apps.
- **Transcript:** activity-timeline labels for every `electron_*` tool ("Launched test app", "Clicked in test app", "Ran app check <name>", …). The `electron` category appears in the agent editor with a description.
- **Qualification:** `node scripts/qualify-electron-apps.mjs` (after `pnpm build`) runs the raw test-instance contract plus all Electron suites with the North Star case enabled, and prints a record.
  - 2026-10-23: darwin 25.6.0 arm64, Node v24.21.0, Electron 37.10.3, backend CDP over `--remote-debugging-pipe`, launch mode development.
  - Contract 7/7 PASS; suites **163 passed / 0 failed**; North Star case 5.7 s.
  - The North Star case covers: launch → first-run Settings closed by click → composer filled → 4-assertion `electron_run` check → screenshot → quit 0 → profile removed → full relaunch shows first-run Settings again (no persistence) → personal `userData`/`~/.<system>` unmodified.
  - Independent fixture covered: multi-window, popup, navigation, every input kind, checks, crash, timeout, Stop, child-process cleanup.
  - The suites must run outside `with-node-sqlite.mjs`, which swaps `better-sqlite3` to the Node ABI and breaks a launched North Star.
- **Unsupported (documented in tool descriptions and here):**
  - packaged/bundled targets (PR120);
  - native OS menus, dialogs and permission prompts (use `electron_handoff`);
  - apps that override `userData` themselves, and home-directory isolation for non-North-Star apps (disclosed in the launch approval);
  - environment overrides;
  - renderer console capture and the "no new console errors" assertion;
  - Windows process-tree teardown and Linux display (unqualified — the flag stays opt-in until they are).

**Setting (2026-10-23).** The `COWORK_ELECTRON_APPS=1` env flag used during phases B–D is gone. The capability is `BrowserSettings.electronApps` (Settings → Browser → "Let the agent launch Electron apps"), **default on** at the user's request, read per turn by `electronAppsEnabled()`. Only an explicit `false` turns it off. Off only stops offering the tools; live sessions keep the host Stop bar, and history is unaffected. Every launch still requires explicit approval.

## Verification and acceptance criteria

Automated contract tests must cover malformed launch descriptors, executable/cwd path substitution, denied/missing approval, environment filtering, unsafe debug flags, foreign sessions/windows/refs, changed approval targets, duplicate launches, lost connections, crash, cancellation, timeout, concurrent selection/action, bounded output and cleanup escalation. Include adversarial page/log text requesting host access or approval bypass; it remains evidence, not instruction.

Check-runner tests must cover malformed or oversized checks, unknown step/assertion types, expression- or script-like strings (rejected or treated as literal text), ambiguous and missing locators, stale windows, effectful steps under denied/approved/Auto modes, cancellation and timeout mid-run, and that a check file cannot launch or reconfigure a session. Qualify that a representative check (roughly 20 steps) runs in seconds against the fixture, and that it gives the same pass/fail as the equivalent exploratory sequence.

Use a real multi-window Electron fixture to verify popup/child discovery, navigation/ref invalidation, typing, select controls, scrolling, drag, pointer-driven tooltip behavior, keyboard traversal, modal Escape/focus behavior, renderer crash recovery and screenshot attribution. Programmatic focus/DOM assertions are not a substitute for input-driven tests. Native OS input remains a separate qualification level; record limitations instead of claiming it from synthetic events.

The full North Star smoke path launches a second instance with a verified disposable profile, demonstrates no normal conversation/settings/database reuse, observes its actual primary window, navigates a local no-provider flow, captures evidence, opens/closes another window when available, closes the test instance and verifies resource cleanup without disturbing the controller. External model/provider actions are a separate opt-in test using controlled credentials and explicit authorization. A component fixture alone cannot satisfy this acceptance case.

Repeat the development-target smoke path through full quit/relaunch and verify persistence is limited to the test profile. Verify development and packaged controller execution separately when claiming those host distributions are supported; packaged target qualification is deferred to PR120. Run targeted unit/integration suites, `pnpm typecheck`, `pnpm test` and `pnpm build` during implementation; record unrelated failures without claiming a clean full suite. Qualification records include OS, host/target/backend versions, launch mode, input method, pass/fail/unverified checks and cleanup results.

Done means an authorized coding agent can launch the real supported development app, see and target its windows, inspect/capture/interact, run a saved declarative check against it in one call, hand control to the user and close it without generated shell automation scripts, cross-conversation access or accidental use of the personal profile. Report launch success, rendered readiness and exercised UI behavior as separate facts. Do not claim bundled/packaged target qualification from development evidence.

## Deferred follow-ups

Bundled/packaged Electron target launch and qualification are deferred to [PR120](120-bundled-electron-application-control.md), listed in the deferred roadmap. Existing-process attachment and personal profiles require a separate consent/ownership design. Native desktop controls, main-process debugging, arbitrary evaluation, generalized environment/service orchestration, PR112 recipe integration and durable QA proof suites are separate work. Backend-specific support decisions are resolved by Phase A and recorded here before implementation proceeds beyond the spike.
