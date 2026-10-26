# PR130: Browser and Electron tools in workflow steps

> Status: **IMPLEMENTED (2026-10-24) — manual verification pending.** Builds on the agent browser and [PR119: Electron application control](119-electron-application-control.md). Let a workflow agent step opt into the agent browser and Electron app control so unattended runs can check their own work and black-box test pages and apps.

## Objective and examples

Today workflow steps never get `browser_*` or `electron_*` tools. Browser tools are offered only when the caller passes `provideBrowser` (`src/main/agent/index.ts`, `browser` / `browserToolDefinitions`). Electron tools are gated on `isLiveTurn = !!opts.provideBrowser`. Only the live chat IPC handler passes a provider (`src/main/index.ts`, `browserManager.handleForTurn`). None of the `runAgentLoop` calls in `src/main/workflows/service.ts` (worker, validator, correction) pass one, and external CLI agents borrow the browser through the same option, so they lose it too.

Target uses:

- **Build, then verify.** A step that builds a web or Electron app launches it, navigates or interacts, and reports observed evidence (snapshots, console errors, failed requests) in its handoff instead of claiming runtime behaviour it never saw.
- **Black-box testing a URL.** A step navigates to a given URL, explores the page, reads the DOM through snapshots, collects element ids, roles, selectors and network activity, and returns a structured report for later steps.

## Step capability, not a global default

Add an explicit per-step capability set to agent steps: `browser` and `electron`, both off by default. Store it in the workflow definition and include it in import/export and versioned persistence. Older definitions load with both off. The editor shows two toggles on agent steps. Electron is unavailable, with the reason shown, when `electronAppsEnabled()` is false or the run's execution config is not a local, writable profile. These are the same conditions chat uses today.

Custom-agent `tools` restrictions still apply on top: enabling the capability offers the tools, and an agent restriction can still remove them. The `browser_advanced` category (`browser_evaluate`) needs its own sub-toggle and stays off unless the step enables it.

## Wiring

- Separate the two meanings of `isLiveTurn`. Today it means "has a renderer to drive" (browser and Electron) and also "registers a mid-turn auto-mode setter". Add explicit options (for example `provideElectron` or `electronEnabled`) so a workflow turn can get the tools without registering into `autoModeSetters`. Chat behaviour must not change.
- Inject a browser provider into `WorkflowService` from `src/main/index.ts`, the same way `summarize` is injected, so the workflow service never imports `BrowserManager`. Pass it only to worker and correction turns of steps whose capability is on.
- External CLI agents get the same provider through the existing bridge (plan 045) when the step enables the browser.
- `browser_handoff` stays blocked in unattended turns (already in the unattended deny list). No other tool may wait on the user.

## Tab and app lifecycle

`handleForTurn` keys tabs by conversation, and each workflow step has its own conversation, so each step gets its own tab. Background conversations already navigate without revealing the surface or switching tabs. Keep that, and let run details open a step's tab in the browser panel.

- Close the step's tab and call `electronApps.closeConversation` when the step reaches a terminal state, and when the run is cancelled or deleted. Don't leak tabs or app processes from failed or interrupted runs; clean up orphans at startup.
- Browser and app state is not durable. After pause/resume or an app restart, the step must re-navigate or relaunch; tell the model this in the browser/Electron state section instead of presenting a stale tab as live.
- Cap concurrent workflow-owned tabs and Electron sessions. When the cap is reached, the step waits or fails with a clear error. It never takes over a chat conversation's tab.
- Decide whether steps in one run share a cookie/storage partition (a logged-in session from step 1 is visible to step 2) or stay isolated. Default to isolated per run, separate from the user's chat browsing profile, and record the decision in `ROADMAP-CLOSED-DECISIONS.md`.

## Unattended safety

Workflow turns run with `autoMode: true`, and the approval gate approves every `require_approval` and `require_explicit_approval` action in auto mode. If nothing changes, a workflow step could auto-click "Delete", "Purchase" or "Submit" on any site, and an Electron `electron_run` with consequential steps would run without a prompt. That is not acceptable for unattended runs.

- **Origin allowlist per step.** A browser-enabled step declares allowed origins (for example `http://localhost:5173`, `https://staging.example.com`). In unattended turns, navigation outside the list is a `hard_block` with an actionable message. Redirects and new tabs are checked against the same list. Local dev hosts are not implicitly allowed. They must be listed like any other origin.
- **Consequential actions.** Actions the browser and Electron classifiers mark consequential (`classifyBrowserClickTarget`, `consequentialStep`, consequential typing/select/dialog/evaluate) are hard-blocked in unattended turns by default. A step may opt into allowing them on its allowed origins only, with editor copy that names the risk. Auto mode must not silently upgrade these to approved.
- Implement this as an unattended-aware decision in the approval policy/gate (`policy.decide` or the gate in `runAgentLoop`), not inside individual tools, so browser, Electron and future surfaces share it.
- Page content, DOM text, console and network output are untrusted data. Keep the existing redaction (`summarizePayload` / `summarizeBrowserPayload`) and bounded results. Don't put raw page text in step handoffs beyond the configured bounds.
- Check how browser and Electron actions count in `unknownSideEffectingToolCalls`. An interrupted click or `electron_run` must block automatic resume the same way other side-effecting tools do.

## Validator access

The validator runs with `readOnlyTools: true`, and `browser_*` is excluded from read-only (`getToolEffects(name)?.readOnly === true && !name.startsWith("browser_")`). For v1, let the validator of a browser-enabled step use observation-only tools (`browser_snapshot`, `browser_screenshot`, `browser_console`, `browser_network`, and `electron_snapshot` / `electron_screenshot` / `electron_status`) on the step's existing tab or app session. No navigation, interaction or launch. The validator then judges against evidence it observed itself. Update the validator prompt to say this. Fresh validator navigation inside the allowlist is listed under Out of scope and can come later.

## Run details

Show browser and Electron tool activity in the step trace like other tools (PR124 presentation), including blocked-origin and blocked-consequential results. Show the step's enabled capabilities and allowed origins in the saved definition and in run details.

## Verification

- Unit: capability persistence/import/export and migration of old definitions; tool offering by capability × agent restriction × Electron availability; chat turns unchanged (provider present, auto-mode setter still registered); workflow turns don't register into `autoModeSetters`.
- Policy: in unattended auto mode, off-allowlist navigation, redirects and new tabs are blocked; consequential browser and Electron actions are blocked unless the step opts in; reversible interactions on allowed origins proceed; `browser_handoff` is still refused.
- Lifecycle: tabs and app sessions close on completion, failure, cancel and delete; startup orphan cleanup; concurrency cap; resume after restart re-navigates instead of using a dead handle; interrupted side-effecting actions block automatic resume.
- Validator: gets only observation tools on the step's session; cannot navigate or interact.
- Run focused tests, typecheck, full tests, build and roadmap verification.
- Manual: (1) a two-step workflow that builds and serves a small local page, then a browser step that loads it on an allowlisted localhost origin and reports console errors; (2) a black-box step against a fixture page (see 112.1's scenario fixtures and test browser) that returns element ids/roles as structured output; (3) an Electron step launching a workspace app and snapshotting a window; (4) confirm a "Delete" click and an off-list navigation are blocked in an unattended run.

## Acceptance

A user can enable the browser and/or Electron app control on a workflow agent step, constrain it to specific origins, and have the step drive the page or app unattended in its own background tab or session, with observed evidence in its handoff and a validator that can inspect the same state. Off-list navigation and consequential actions don't happen silently, and tabs and app processes don't outlive their run.

## Out of scope

Browser access for workflow command steps (PR126/127), validator navigation or interaction, sharing the user's chat browsing profile or sign-ins with workflows, a headless browser that runs without the app window, recording/replaying browser scripts, and parallel browser fan-out within one step.

## Implementation notes (2026-10-24)

- Step fields: `browser`, `allowedOrigins` (normalized origins), `browserEvaluate`, `electron`, `allowConsequential`. Validated in `validateWorkflow`, included in import/export. Absent means off.
- `src/main/agent/approval/unattended-classifier.ts` is the shared guard. The `runAgentLoop` gate consults it before auto mode, and the CLI bridge's browser gate consults it too. It can only hard-block.
- `browser_evaluate` is controlled by its own toggle, independent of `allowConsequential`.
- Workflow tabs get their own partition. `will-navigate` and main-frame `will-redirect` are checked against the allowlist, and `window.open` is denied rather than checked.
- Unattended turns never register a live auto-mode setter. `provideElectron` makes Electron explicitly opt-in, and `electron_handoff` joins the unattended deny list.
- Lifecycle: the tab and app sessions close when the step completes and on every `execute` exit (failure, pause, cancel, shutdown). Startup orphan cleanup is the existing `electronApps.reconcile()`; browser tabs are in-memory. A cap of 4 concurrent workflow surface steps fails the step that goes over it.
- Interrupted browser/Electron calls already block automatic resume: their effects are not read-only, so `unknownSideEffectingToolCalls` counts them.
- Not done: the manual checks above, and a "view this step's tab" button in run details (opening the step's conversation shows its tab).
