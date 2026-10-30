# PR117: Sandboxed HTML and React previews

> Status: **Deferred — not implemented.** Activate only after [PR115: inline artifacts](115-inline-analysis-artifacts.md) ships, real redesign tasks demonstrate the fidelity limits of [PR116: constrained UI concepts](116-ui-concept-previews.md), and an explicit security/packaging investigation can prove the proposed isolation boundary. PR115 is an infrastructure dependency; PR116 provides product evidence, not a security prerequisite.

## Objective and reason for deferral

Allow an agent to present a high-fidelity HTML/CSS or React concept with source inspection and bounded diagnostics, useful viewport sizes and immutable revisions. This is a separate preview runtime, not an extension that evaluates generated JSX inside North Star's main renderer.

Defer because executing untrusted generated code creates runtime, compiler, resource-management and packaged-platform obligations that the installed shadcn components do not solve. An iframe, CSP declaration or successful happy-path demo alone is not proof of isolation. Structured artifacts deliver useful value first and establish whether this complexity is warranted.

A rendered concept is not proof that the user's actual application was changed, built or validated. This feature must not replace [PR112's app acceptance validation](112-app-run-recipes-and-acceptance-validation.md).

## Evidence and starting points

The installed `components/ui` files are React source modules bundled into the trusted application. They are not a ready-made library that arbitrary generated code can import. `changed-files-bar.tsx` contains a script-disabled HTML iframe; its current behavior is a reference for inert previews, not a license to enable scripts or same-origin capabilities.

PR115 owns durable artifact identity, revisions, scoped reads, quotas, ownership, invocation retry behavior and transcript references. Reuse those contracts for stored preview source and metadata. Preview sessions and compiler/runtime resources are ephemeral and revision-specific; do not put live process handles into durable conversation content.

Before design approval for executable React, re-audit the current Electron window/session/preload configuration, protocol/resource handlers, browser manager, packaging and supported operating systems. Do not assume the existing agent browser is a suitable preview boundary or reuse its authenticated session.

## Product and source contract

A proposed future preview tool accepts an explicit supported mode, title, bounded source files and a selected vetted dependency profile. Model-provided file names are virtual bundle paths with strict normalization; they cannot address host files, project config, absolute paths or arbitrary URLs. Exact schema and tool names follow the isolation spike, not the other way around.

Stored revisions are immutable. Keep source inspectable and distinguish build errors, runtime errors, blocked capabilities and stopped sessions. Diagnostics are bounded and associated with the correct revision. Do not report successful compilation as successful rendering, or successful rendering as correct application behavior.

The host offers explicit start/restart/stop controls for executable previews. Merely opening an old conversation or expanding its tool trace must not automatically execute old source. A static rendered fallback or source view remains useful when execution is unavailable. Expansion and viewport selection are host controls, separate from generated buttons.

Initial preview dependencies are locally bundled, pinned and finite. External npm imports, package installation, CDN modules and arbitrary project assets are out of scope. A later request for project-faithful rendering needs a separate authorization and asset/dependency design, not a transparent fallback to running the project's build.

## Architecture decision gate

Investigate an isolated Electron renderer/session plus a constrained compilation worker/process. Generated source must not run in the main application renderer, main process, application preload or an unrestricted Node-based build plugin environment. Select the concrete architecture only after proving its available primitives in development and packaged builds.

The preview environment has no North Star preload, `window.cowork`, Node integration, privileged IPC, shared authentication/session storage, host filesystem capability or ambient permission grants. Renderer sandboxing and context isolation must be explicit. An opaque or dedicated origin and disposable storage partition must be designed together with request/navigation policy; do not casually combine script execution with same-origin permissions that defeat containment.

A sandboxed iframe may be one layer within an isolated preview window, not the whole design. Establish how the host terminates a hung child without depending on a responsive generated event loop and how it caps resources on each supported OS. If hard limits cannot be enforced, narrow the supported mode or keep executable React deferred rather than relying only on cooperative timers.

Document the selected security boundary, capability matrix, residual risks and fail-closed startup checks before building the product UI. No execution is enabled if required isolation settings or request restrictions fail to initialize.

## Threat model and denied capabilities

Treat source, serialized data, virtual assets, dependencies and messages from the preview as untrusted. The threat model includes parent/frame access, prototype/global manipulation, Electron/Node escapes, preload/IPC access, local and application protocol reads, navigation/popups, downloads, permission requests, network exfiltration, workers/service workers, storage persistence, clipboard access, message spoofing, misleading host-like UI and resource exhaustion.

Default to no network, enforced by the host/session boundary as well as CSP, not by generated code's choice to avoid `fetch`. Cover requests from CSS, fonts, images, modules, frames, forms, WebSockets, redirects and navigations. Disallow external and file/app URLs and unvetted custom schemes. Test the actual shipped Chromium behavior rather than assuming a request hook covers every channel.

Disable or explicitly constrain popup/window creation, top navigation, downloads, permissions, clipboard, service workers and background workers. Keep generated content visually framed so it cannot impersonate native application permission chrome. Do not pass secrets, model credentials or workspace paths into runtime props or diagnostics.

The only host-message channel, if needed, uses a narrow versioned protocol, per-session capability, expected sender/frame checks and bounded validated payloads. Opaque-origin messages require source/session verification rather than trusting an origin string such as `null`. No generic tool execution, filesystem, arbitrary IPC relay, instruction installation or approval API is exposed. Buttons in the generated UI cannot grant authority over North Star.

## Compilation and dependency isolation

Compiling generated code is itself a trust boundary. Do not invoke a workspace's Vite/Webpack config, package scripts, compiler plugins, shell hooks or dependency installer. A vetted compiler consumes normalized virtual source and explicitly provided modules only. Reject unresolved imports, dynamic/evaluated dependency loading and unauthorized asset references rather than attempting to install or fetch them.

Keep compilation out of the main process and cap source size, file count, import depth, output size, diagnostic volume, wall time and memory/CPU consumption using enforceable host controls. Terminate runaway jobs and clean temporary resources even when a renderer crashes or an app closes. Pin and review compiler/runtime dependencies; do not let a model select executable build options.

A supported shadcn preview library is a separately built, versioned module set with compatible React, styling, icons and any chart dependencies. Audit components for portals and resource access before inclusion. The existing source directory does not become a runtime import resolver. Do not share React objects or application context across the security boundary.

## Runtime lifecycle, assets and data ownership

Tie each build/session to an authorized conversation, artifact and exact revision, with server-owned session IDs. Cancel superseded compilation and dispose superseded sessions. A late build result must not overwrite the active revision. Replays and retries must not spawn duplicate runtimes.

Store source/blobs under app-owned artifact storage with explicit per-artifact/conversation quotas, retention and deletion behavior inherited or extended from PR115. Asset serving maps only authorized content-addressed blobs through a narrow resource service; it must not expose host paths or allow path traversal, symlink reads or cross-conversation access. Provide safe MIME handling and bounds.

Do not inherit browser cookies, local storage, user accounts or project secrets. Dispose partitions and transient resources on stop, deletion, failure and app shutdown according to a tested lifecycle. Preserve durable source even when a runtime crashes so the user can inspect it without executing it.

If an agent needs to inspect a rendered preview, introduce a separately authorized host capture path bound to the exact session/revision. Captures and console output are attributed untrusted tool data, not instructions or proof that the actual application works. Arbitrary host browser evaluation is not a necessary capability of this feature.

## Staged implementation and go/no-go gates

### Phase A: Security and packaged-runtime spike

Build a dev-only minimal isolation harness and threat-test fixture set, not a product feature. Compare the feasible isolated renderer/session and compile-worker arrangements. Verify no preload/Node/IPC/network/local-resource access, deterministic teardown and enforceable resource handling. Produce evidence for every supported OS and packaged mode. Review residual risks and choose a fail-closed boundary before promoting the work.

If platform primitives cannot satisfy the minimum boundary, stop. Keep source viewing and inert static rendering available and executable React deferred. Do not lower the security bar because the demo renders.

### Phase B: Inert HTML/CSS preview

Integrate script-disabled static source with PR115 persistence and transcript references. Sanitize/restrict markup, URLs and CSS resource references as needed, enforce no-network policy, exclude active embedded content, and test containment. Do not weaken an existing iframe sandbox as incidental cleanup. Ship this slice separately only if it is useful and passes its own acceptance criteria.

### Phase C: Bounded React runtime

After the isolation gate passes, add the vetted compiler and finite module profile, explicit start/stop controls, source/diagnostic views and supported local interactions. Disallow imports outside the profile. Ensure runtime and compiler failures do not destabilize chat or expose privileged errors. Keep both behind a feature flag until qualification completes.

### Phase D: Opt-in exposure and qualification

Expose the preview tool only in compatible contexts and document capability limits in prompts. Verify tool availability and explicit provider/MCP adapters instead of implicitly widening tool access. Add real design tasks and adversarial cases to packaged qualification. Keep a host-side kill switch and a source-only fallback; disable execution independently of durable source access.

Likely ownership is a main-process preview session/resource manager, isolated renderer entry/preload-free window, constrained compile worker, shared preview schemas and artifact renderer adapters. These are architecture candidates until the spike, not confirmed module paths. Do not reuse privileged browser or task executors merely to avoid creating a clear boundary.

## Verification and acceptance

Use a dedicated adversarial fixture matrix covering script/markup injection, forbidden imports and dynamic loading, compiler plugin/config attempts, file/app protocol reads, parent/frame access, forged messages, navigation/popups/downloads, clipboard/permission requests, workers/service workers, persistent storage and exfiltration from CSS/media/font/module/form/WebSocket paths. Prove denial from outside generated code; absence of a visible request in the preview is not sufficient evidence.

Exercise infinite render loops, compilation stalls, oversized sources/assets, excessive output, repeated revision churn, crash, stop during build, restart, shutdown, conversation deletion and stale-result arrival. Measure host responsiveness and confirm processes, partitions, temporary files and resources are reclaimed. Fail closed if startup isolation checks fail. Do not run unbounded adversarial code in the trusted test process.

Functional tests cover source identity and exact revisions, scoped asset access, bounded diagnostics, build-vs-render status, inert historical loading, explicit execution, unsupported runtime fallback, duplicate invocation handling, live/reload references and no action authority from generated controls. Accessibility and real Electron checks cover framing, keyboard/focus, narrow/expanded viewports, themes, text selection and error recovery.

Run targeted unit/integration/security suites, `pnpm typecheck`, `pnpm test`, `pnpm build`, and documented packaged-platform qualification. Unit tests alone cannot prove Electron isolation, resource enforcement or production asset loading. Acceptance requires recorded deny-path evidence, successful cleanup/hang recovery and a useful prototype workflow without privileged access. Rollback disables execution while retaining safe source inspection and immutable records.

## Explicit non-goals

No unrestricted npm, IDE, terminal, arbitrary workspace build execution, real backend integrations, secrets, authenticated browsing, autonomous publication, network exceptions selected by generated props, approval bypass, automatic execution of historical previews, complete project-style fidelity, or guarantees that rendered source is production-ready. This is not a replacement for PR112 or an excuse to expand PR116's declarative language indefinitely.

## Sources and research limitations

This plan follows the local artifact/transcript/UI seams researched for PR115/PR116 and the existing script-disabled HTML preview. No Electron isolation spike, compiler choice, adversarial execution or packaged-platform qualification was performed in this planning session. All executable architecture details are conditional on the security gate; installed shadcn components alone do not establish feasibility or safety.
