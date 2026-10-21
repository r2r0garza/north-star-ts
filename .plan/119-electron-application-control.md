# PR119: First-class Electron application launch and control

> Status: **PLANNED — not implemented.** Drafted 2026-10-21. This document proposes a capability; it does not authorize launching apps, installing dependencies, or implementing the tools.

## Objective

Give North Star agents a first-class capability to launch a real Electron application, inspect its windows, capture screenshots, interact with its UI, read bounded diagnostics, and stop it. Launching North Star itself in an isolated test instance is a primary acceptance case. Agents should not need to generate temporary Electron main-process scripts or drive an entire qualification session through `exec_command`.

This is application automation, not an Electron window embedded inside the agent browser. The target runs as a separate process with its own native windows. A successful component fixture is not evidence that the full application works, and a successful development run is not evidence that the packaged app works.

The user asked for a new launch capability, not implementation yet. This plan includes the minimum companion controls needed to make launch useful for testing; they share one managed application session rather than introducing a general desktop-control system.

## Current evidence and related work

`scripts/qualify-inline-artifacts-electron.mjs` builds a fixture using production renderer components, launches a visible `BrowserWindow`, and drives it with `webContents.executeJavaScript()`. It demonstrates real Electron rendering, but is neither a full North Star launch nor reliable native keyboard/pointer coverage. Preserve it as a regression fixture, not as the proposed product implementation.

The existing agent browser has conversation-owned sessions, per-turn abortable handles, snapshot refs, image emission, bounded diagnostics and approval-aware tools. Relevant references are `src/main/browser/manager.ts`, `src/main/browser/session.ts`, `src/main/agent/tools/browser/`, `src/main/agent/tools/types.ts`, and `src/main/agent/approval/types.ts`. Its sessions belong to North Star; an external application's BrowserWindows cannot simply be added to that manager or reparented into its sidebar.

`package.json` currently includes Electron as a development dependency and does not declare Playwright. A packaged host cannot assume the development Electron executable, Node, pnpm, or Playwright is installed. Dependency/runtime resolution and packaging must be explicitly qualified, not implicitly downloaded during launch.

[PR112](112-app-run-recipes-and-acceptance-validation.md) covers app recipes and acceptance proof orchestration. This capability can supply its Electron runtime adapter later; it does not implement that orchestration or depend on planned PR112 code being present. [PR117](117-sandboxed-html-react-previews.md) is a separate untrusted-preview isolation problem, not an application automation backend.

## Scope and boundaries

Initial support is for agent-owned launches of an explicitly identified local Electron development app or packaged executable. Include multiple target windows, navigation/reload invalidation, diagnostics, screenshots, deterministic cleanup and a human handoff. Start with workspace-backed local North Star mode; do not silently offer host execution to Chat without a workspace, remote/container workspaces, or unsupported provider bridges.

Attaching to an already running personal app, controlling the live North Star host, arbitrary CDP endpoints/PIDs, general OS desktop automation, native menus/dialog automation, dependency installation, automatic app building and persistent unattended app services are out of scope. Native dialogs may require a handoff. Unsupported packaged apps return a precise capability error rather than silently relaunching with weakened security flags.

A target application executes code with the user's OS privileges. Its main process, preload, IPC and dependencies can access host resources. A new user-data directory prevents accidental profile reuse only when the target actually honors it; it is not a filesystem or network sandbox. Do not claim otherwise. Default tests must use controlled accounts/data and avoid real external mutations.

## Proposed model-facing contract

Use a dedicated `electron_*` family rather than overloading `browser_*`. Names and precise schemas are provisional until the backend spike, but the operations and authority boundaries are part of the design.

| Tool | Contract |
| --- | --- |
| `electron_launch` | Launch one approved executable with an argument array, explicit launch mode and optional workspace-relative cwd. Return host-owned `sessionId`, launch/profile status and current windows, or a bounded startup error. No shell command string. |
| `electron_status` | List this conversation's sessions or inspect one session's lifecycle, windows, selected target, exit information and bounded startup diagnostics. Must not launch or reconnect to arbitrary processes. |
| `electron_select_window` | Select an owned `windowId` obtained from status; return title, URL and new target generation. Never guess the first window when several are eligible. |
| `electron_snapshot` | Return a bounded accessibility-oriented outline with actionable refs scoped to session, window and document/snapshot generation. |
| `electron_screenshot` | Capture the selected application renderer via the existing validated image/media delivery pipeline, not a screenshot of unrelated desktop windows. |
| `electron_interact` | A discriminated schema for click, hover, drag, fill/type, select, key press and scroll. Ref-based pointer actions use the automation input pipeline, not DOM `.click()` masquerading as a pointer test. |
| `electron_wait` | Bounded waits for window lifecycle, document readiness, ref visibility/absence or URL changes. No arbitrary predicate code. |
| `electron_console` | Cursor-based bounded renderer console, application stdout/stderr and crash records, attributed to the correct session/window/source. |
| `electron_handoff` | Bring the target forward and pause for the user to complete login, native UI or other human-only steps. Resume with fresh window inventory and refs. |
| `electron_close` | Gracefully close an owned app session, then bounded escalation against only its verified owned processes. Report cleanup outcome. Idempotent. |

Every window operation supplies a `sessionId`; selection is session-local and conversation-owned. Returned refs are opaque and do not act as selectors in unrelated windows. A stale or detached target requires a fresh inventory/snapshot rather than fallback to another visible window. Discover the main UI, splash screens, settings windows and popups without treating every Chromium target as an eligible renderer.

Launch inputs are bounded and normalized. Validate executable identity, cwd, argument count/length, timeouts and supported modes before approval. Dev mode may use a resolved Electron executable plus an explicit app entry; packaged mode uses the resolved app executable (including platform-specific bundle resolution). Do not guess app arguments or run package scripts as a hidden launch step. Report missing builds/dependencies as actionable errors; build/install remains a separate approved operation.

Do not expose arbitrary main-process evaluation, Node evaluation, IPC invocation, preload installation, raw debugging protocol forwarding, unrestricted environment inheritance, or free-form JavaScript evaluation in the initial tools. If advanced evaluation is later justified, give it a separate design, permission and approval boundary; the browser's page-only guarantees do not transfer to Electron renderers with Node/preload access.

## Backend decision gate

Create a main-process-owned Electron application session manager with a narrow automation adapter. Investigate pinned Playwright Electron support first, including its experimental/version-sensitive limitations. Compare renderer-only CDP connection if necessary; do not conflate a renderer connection with control of the Electron application lifecycle. Choose one supported backend after demonstrating development and packaged launches, not by assuming Playwright is already bundled.

Keep privileged application handles inside trusted host code. Model arguments can only address operations in the narrow contract; they cannot invoke the backend's Electron main-process evaluation API. Treat launch/debugging access as authority over the target, never as a safe read-only attachment.

Prove transport ownership and locality. Prefer an owned pipe/private transport when supported. If loopback debugging is necessary, validate connection to the process launched by this session, minimize its lifetime and document local-process exposure. No public debugging listener, model-supplied endpoint, inherited debug flags, arbitrary process discovery, or attachment to the controlling North Star instance. Reject unsupported unsafe launch flag combinations rather than disabling Chromium sandboxing or web security to make a test pass.

Resolve automation dependencies in the packaged host explicitly. Do not require global Node or download a second browser runtime just to automate an app's own Electron. Qualify ASAR/resource paths, subprocess execution, native modules, signed/packaged executable restrictions, macOS application bundles, Windows process trees and Linux display requirements. Publish a supported-version/platform matrix and explicit unsupported states.

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

Choose and pin the automation backend only after a small fixture and a full North Star dev instance demonstrate launch, window inventory, renderer snapshot/capture, real automation input and teardown. Establish North Star's test-profile startup contract. Record which flags/transports are required, privilege exposure, packaging constraints and the OS/version support matrix. Verify no access to the controller window or default user profile. No production tool exposure until this gate passes.

### Phase B: Managed launch, ownership and diagnostics

Implement schemas, launch approval, profile/environment policy, session state machine, invocation retry behavior, bounded logs, status/windows, close and cleanup. Add cancellation, timeouts, owner checks and host lifecycle wiring. Provide host-owned stop visibility. Verify packaged dependency resolution before claiming the host can ship the feature.

### Phase C: Renderer inspection and interaction

Add selected-window snapshots, stale-safe refs, screenshot media emission, discriminated interactions, waits and handoff. Integrate action approval and per-session scheduling. Test actual input behavior separately from DOM state manipulation. Do not silently add JavaScript evaluation to compensate for missing interactions.

### Phase D: Capability exposure and end-to-end qualification

Wire explicit tool permissions, supported modes/providers, prompt guidance, context state and transcript representation. Qualify the full North Star app and at least one independent Electron fixture, then packaged targets on supported platforms. Document unsupported native UI and apps that cannot establish isolated launch. Ship behind an opt-in feature flag until qualification passes; disable launch independently of historical evidence rendering.

## Verification and acceptance criteria

Automated contract tests must cover malformed launch descriptors, executable/cwd path substitution, denied/missing approval, environment filtering, unsafe debug flags, foreign sessions/windows/refs, changed approval targets, duplicate launches, lost connections, crash, cancellation, timeout, concurrent selection/action, bounded output and cleanup escalation. Include adversarial page/log text requesting host access or approval bypass; it remains evidence, not instruction.

Use a real multi-window Electron fixture to verify popup/child discovery, navigation/ref invalidation, typing, select controls, scrolling, drag, pointer-driven tooltip behavior, keyboard traversal, modal Escape/focus behavior, renderer crash recovery and screenshot attribution. Programmatic focus/DOM assertions are not a substitute for input-driven tests. Native OS input remains a separate qualification level; record limitations instead of claiming it from synthetic events.

The full North Star smoke path launches a second instance with a verified disposable profile, demonstrates no normal conversation/settings/database reuse, observes its actual primary window, navigates a local no-provider flow, captures evidence, opens/closes another window when available, closes the test instance and verifies resource cleanup without disturbing the controller. External model/provider actions are a separate opt-in test using controlled credentials and explicit authorization. A component fixture alone cannot satisfy this acceptance case.

Repeat the supported smoke path against a packaged target, including full quit/relaunch and persistence limited to the test profile. Verify dev and packaged controller execution separately. Run targeted unit/integration suites, `pnpm typecheck`, `pnpm test` and `pnpm build` during implementation; record unrelated failures without claiming a clean full suite. Qualification records include OS, host/target/backend versions, launch mode, input method, pass/fail/unverified checks and cleanup results.

Done means an authorized agent can launch the real supported app, see and target its windows, inspect/capture/interact, hand control to the user and close it without generated shell automation scripts, cross-conversation access or accidental use of the personal profile. Report launch success, rendered readiness, exercised UI behavior and packaged qualification as separate facts.

## Deferred follow-ups

Existing-process attachment and personal profiles require a separate consent/ownership design. Native desktop controls, main-process debugging, arbitrary evaluation, generalized environment/service orchestration, PR112 recipe integration and durable QA proof suites are separate work. Backend-specific support decisions are resolved by Phase A and recorded here before implementation proceeds beyond the spike.
