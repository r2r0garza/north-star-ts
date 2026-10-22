# PR120: Bundled Electron application launch and control

> Status: **DEFERRED — not implemented.** Split from PR119 on 2026-10-21 at the user's direction. Listed in [Roadmap — Deferred](ROADMAP-DEFERRED.md). This proposal does not authorize implementation, launching apps, or installing dependencies.

## Objective and relationship to PR119

Extend the managed Electron application capability to explicitly identified bundled/packaged Electron targets only when a concrete need justifies it. [PR119](119-electron-application-control.md) is the coding agent's capability for launching and testing workspace-backed Electron apps under development. It must not wait for this extension or claim packaged-target support from development evidence.

This plan retains the packaged-target work removed from PR119. It is not a general computer-use capability: arbitrary desktop control, attachment to personal running apps, and automation of unrelated applications remain out of scope. A packaged North Star target would still be a separate authorized test instance, never the controlling host.

A packaged controller and a packaged target are distinct concerns. PR119 may qualify its automation dependencies inside a shipped North Star controller while continuing to support only development targets. This plan concerns the application being launched.

## Activation and dependency gate

Keep this work deferred until packaged-target testing has a demonstrated use case and PR119's session ownership, approval, isolation, interaction and cleanup contracts are established. Recheck the chosen backend and supported versions before implementation; do not assume a development-compatible backend can launch every bundled Electron application.

## Proposed scope

Add an explicit packaged-target launch mode to the existing managed `electron_*` family rather than a parallel desktop-control system. Resolve a canonical application executable, including platform-specific bundle resolution, and validate its argument array and cwd. Do not guess app arguments, install applications, build packages as a hidden launch step, attach to arbitrary PIDs/CDP endpoints, or silently substitute another executable.

Investigate and qualify signed/packaged executable restrictions, macOS application bundles, Windows executable/process-tree behavior, Linux packaged application/display requirements, and target-specific Electron/backend compatibility. Publish a supported-version/platform matrix with precise unsupported states. Unsupported targets must fail without disabling Chromium sandboxing, web security, signing protections or other security checks.

Reuse PR119's conversation-owned sessions, window inventory, stale-safe refs, bounded screenshots/diagnostics, actual automation input, human handoff, cancellation and verified process cleanup. Do not introduce arbitrary main-process evaluation, Node evaluation, IPC invocation, preload injection or raw debugging protocol access as a compatibility workaround.

## Approval, environment and profile isolation

Extend launch approval identities to bind the resolved packaged executable/bundle identity, arguments, cwd, environment descriptor and profile policy. Revalidate the approved target before spawn; one development launch approval must not authorize a packaged application or a different binary. Preserve the existing gate's action classification for consequential UI operations; launch approval is not blanket authorization for external mutations.

Establish how each supported packaged target honors a disposable profile before storage/database initialization, and verify that behavior. A generic Electron profile flag is not sufficient evidence. Refuse default isolated launch when it cannot be established; do not silently reuse a personal profile, bypass singleton locks or copy credentials/history. Personal-profile mode and existing-process attachment require separate consent/ownership designs.

Use a minimal documented child environment, keeping provider keys, inherited injection variables and personal browser profiles out by default. A disposable profile is not a host filesystem/network sandbox: the target main process, preload, IPC and dependencies still execute with OS privileges and may access local credentials or workspace configuration. Use controlled test data/accounts and disclose residual access.

## Implementation outline

First perform a packaged-target backend and isolation spike using a deliberately built Electron fixture and a packaged North Star test instance. Record platform/runtime/backend versions, required transport, launch flags, profile evidence and unsupported combinations before exposing the mode.

Then extend validated launch descriptors, canonical executable/bundle resolution, approval identity, diagnostics and cleanup without weakening PR119's development path. Keep the extension independently opt-in so unsupported packaged targets do not regress development-app testing.

Finally qualify target-specific startup, windows, interaction, shutdown and full relaunch. Add truthful mode/support reporting to tool descriptions and the session surface; do not imply compatibility with all installed Electron apps.

## Verification and acceptance criteria

Test malformed or substituted bundle/executable paths, changed binary identity after approval, denied launches, unsupported backend/target versions, environment filtering, unsafe flags, failed profile isolation, singleton collisions, startup timeout, crashes and verified process-tree cleanup. Reuse ownership, stale-ref, concurrency, cancellation, output-bound and prompt-injection regression coverage from PR119.

Run the full supported smoke path against packaged targets: launch with a verified disposable profile, observe the actual primary window and other eligible windows, inspect/capture/interact using automation input, close, fully quit and relaunch, and verify persistence is limited to the test profile. For packaged North Star, demonstrate no reuse of the controller's normal conversations/settings/database and no disturbance of the controller. Provider/network mutations remain separate opt-in tests using controlled credentials and explicit authorization.

Verify development and packaged controller execution separately from target packaging. Record OS, controller/target/backend versions, launch mode, input method, pass/fail/unverified checks, profile assurance and cleanup results. Development-only or component-fixture results cannot satisfy packaged-target acceptance.

Done means an authorized agent can launch and control explicitly supported packaged Electron test targets under the same ownership and approval boundaries as PR119, with documented compatibility limits and no accidental personal-profile use. This plan does not expand into general computer use.
