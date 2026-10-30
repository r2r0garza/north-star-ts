# PR116: Constrained UI concept previews in conversation

> Status: **Completed 2026-10-23** (Phases A–D plus the alternatives follow-up; user-tested in the app). Qualification limitations are recorded below. Next up after [PR115: inline analysis artifacts](115-inline-analysis-artifacts.md), whose durable artifact, revision and transcript contracts this plan reuses. Higher-fidelity code previews are separately [deferred in PR117](117-sandboxed-html-react-previews.md).

## Objective and recommendation

Let an agent answer a redesign request with a rendered screen concept instead of relying on prose, ASCII or Mermaid. The user can inspect a compact inline preview, expand it, try supported local interactions and request a revision. The preview communicates design intent; it does not implement or verify changes in the user's application.

Expose one constrained presentation tool, working name `present_ui`, backed by a host-maintained registry of approved component compositions. The model supplies data describing a tree, not JSX, HTML or arbitrary props. Do not expose every component in `components/ui` merely because it is installed.

Keep the vocabulary intentionally small and measure it against representative redesign requests. If high fidelity requires a programming language, stop extending the schema and consider PR117 rather than growing an unbounded home-made frontend framework.

## Evidence and dependencies

The installed UI directory already contains layout-adjacent primitives, cards, buttons, badges, separators, tabs, tables and form controls. `transcript.tsx` and `lib/timeline.ts` are the presentation seams identified in PR115. PR115 owns artifact storage, invocation association, immutable revisions, limits, reference transport, ownership checks, retry idempotency and live/historical projection. Extend that envelope with a UI-concept kind instead of creating another storage or transcript system.

`changed-files-bar.tsx` has a script-disabled HTML iframe, but this plan does not turn it into an executable code preview. A trusted registry can render approved data in React without executing generated JavaScript; its security boundary is strict validation and deliberately limited capabilities.

[shadcn Questionnaire](https://ui.shadcn.com/docs/components/base/questionnaire) is a potential separate improvement to the existing clarification UI. It is not installed locally and is not needed to deliver this feature. Do not add a questionnaire tool or replace `ask_user_question` as part of PR116.

## User experience and fidelity contract

Present the artifact as a “UI concept,” with an agent-provided title and concise description. Support useful preview widths in a host-owned expanded view so a full screen is not judged solely at chat-column width. Show the active revision. Distinct alternatives can be separate artifacts, avoiding a new cross-artifact comparison subsystem in the first slice.

Use app theme defaults and artifact-local design tokens for a coherent prototype. Provide bounded choices for density, typography scale, spacing, alignment and surface/accent roles so the result can express hierarchy rather than only generic identical cards. Do not add decorative labels, metrics or filler content unrelated to the request. Sample data should be identified as sample data, not findings about the workspace.

Keep local preview controls visually within the concept frame. Host-owned actions such as expand or “Use this direction” sit outside it, making it clear which buttons belong to the mockup and which communicate with the agent.

Previewing or choosing a concept does not edit source files, install packages, approve a pending tool, or mean the actual app passed an acceptance check. Styling is approximate unless the host's supported tokens happen to match the project; no promise of arbitrary brand or project fidelity.

## Declarative schema and supported vocabulary

The initial tree vocabulary comprises `stack`, `row`, `grid`, `text`, `separator`, `card`, `badge`, `button`, `table`, `field`, `input`, `select`, `switch` and `tabs`, with strict required fields and child relationships per kind. Prefer small composed adapters over exposing raw shadcn internals. Charts may reference or embed validated PR115 chart specifications through the same renderer; do not introduce another chart language.

A proposed schema example, subject to implementation-time type naming:

```json
{
  "title": "Notification settings concept",
  "description": "A compact settings layout with grouped preferences.",
  "tree": {
    "type": "stack",
    "gap": "lg",
    "children": [
      { "type": "text", "role": "heading", "text": "Notifications" },
      {
        "type": "card",
        "children": [
          {
            "type": "field",
            "label": "Weekly summary",
            "children": [
              { "type": "switch", "id": "weekly-summary", "defaultChecked": true }
            ]
          }
        ]
      }
    ]
  }
}
```

Define heading levels, field/control associations, tab labels and table semantics through explicit schema rules. The host owns DOM IDs and maps artifact-local identifiers into a unique namespace. Never trust supplied IDs as selectors into the surrounding application.

Allow only finite tokens for gap, padding, alignment, width, column count, text role, emphasis, variant and responsive breakpoints. No arbitrary Tailwind classes, inline CSS, style strings, raw DOM attributes, URL-based CSS, imports, module paths, React component names, HTML, expressions, refs or event handlers. Unknown properties and unsupported nodes produce precise validation errors rather than being forwarded to components.

Set named limits for node count, nesting depth, state count, text length, field options, table cells and total serialized payload. Enforce them in the main process before persistence and in a defensive renderer adapter for old/malformed content. Validate child relationships so bad trees cannot produce nested forms/buttons or inaccessible unlabeled controls. Use plain text escaping; do not add raw HTML support to Markdown.

## Local interaction model

The host implements a finite interaction vocabulary. Tabs switch panels; inputs, selects and switches update ephemeral demo state. A designated button may transition to one of a small set of declared preview states. State transitions are named targets validated up front, not expressions, string evaluation, arbitrary bindings or callbacks.

Do not add a general computation engine, scripting API or network client. There is no real form submission, credential collection, filesystem access, navigation to arbitrary destinations, or application IPC exposed to model-described nodes. Demo fields should not suggest entering passwords or other sensitive real data. Entered values remain local and are not persisted or automatically sent to the agent.

Local state resets on revision changes and reload in the initial version. Define this behavior visibly where needed; avoid silently promising durable form state. Do not invoke the model when a user toggles a switch, changes tabs or clicks a demo button. Unsupported business actions remain clearly non-operational rather than pretending to save real data.

## Containment and accessibility

Use a scoped preview root and artifact-local tokens without changing global app classes, theme attributes or document styles. Native form behaviors must not submit the chat composer. Prevent preview keyboard events from accidentally triggering global application shortcuts where appropriate, without breaking normal text editing, tab navigation or screen-reader interaction.

The initial registry excludes modal dialogs, sheets, popovers and other portaled overlays. Add one only when a real use case needs it and its portal can be contained, styled, focus-managed and tested inside the preview. No content should escape into application chrome or imitate host permission prompts.

Host-owned expanded dialogs retain normal focus trapping, escape behavior and focus restoration. Preview content itself should not create a focus trap. Keep labels, heading order, tab semantics, contrast and reduced-motion behavior intact. Bound horizontal/vertical overflow without hiding important controls; test keyboard access at narrow widths and increased text size.

## Revisions and explicit user feedback

Reuse PR115's stable identity and immutable revision handling. A redesign follow-up creates a new revision associated with the current authorized conversation/invocation; historical entries keep the exact old revision. Retry and conflict behavior must remain identical to other artifacts.

Optionally provide one host-owned “Use this direction” feedback action once presentation is proven. Dispatch only on explicit user intent and include artifact ID, exact revision, optional alternative identity and a small host-authored message. Attribute it as a user action, not as text supposedly typed by the person. Resolve ownership server-side and prevent duplicate dispatch while a request is pending.

Do not let tree nodes supply arbitrary feedback text, message roles, approval tokens, tool calls or persistent instructions. Feedback selects a design direction; existing approval policy still governs later edits, commands and external actions. The user can always request revision through ordinary chat; feedback controls are not a new requirement to pause every preview-producing turn.

## Implementation sequence and likely seams

### Phase A: Minimal typed concept renderer

Extend the shared PR115 artifact union and validators with the UI-concept kind. Implement a small registry near the artifact renderer, using installed primitives and explicit prop construction rather than unrestricted prop spreading. Start with layout/text/card/button/table and one form group; prove tree validation, scoping and visible failure states end-to-end before adding controls.

Phase A implementation notes (2026-10-23):

`shared/conversation-artifacts.ts` adds the `ui_concept` kind, a strict recursive validator and `PRESENTATION_TOOLS`, which every presentation seam (settlement, reads, message projection, scheduler reconciliation, transcript/run readers) now checks instead of repeating tool-name lists. The vocabulary is stack/row/grid/text/separator/card/badge/button/table/field/tabs; `input` (no password type), native `select` and `switch` exist only as a field's `control`, so unlabelled controls and nested buttons cannot be expressed. Each node copies only declared fields; unknown fields/types are precise errors. Limits: 200 nodes, depth 12, 500-character text, 20 select options, 2–6 tabs, 12×50 table cells, plus the shared 256 KiB/quota bounds. Concepts carry no sample/model IDs; field associations use host `useId`. Storage, revisions, conflicts (including cross-kind) and retries reuse the PR115 repository unchanged; references report `rowCount: 0`.

`present_ui` is registered next to the other presentation tools (same modes, plan-mode withholding, `presentation` custom-agent category, CLI bridges still excluded) with mode-prompt guidance. `ui-concept-preview.tsx` maps validated tokens to literal class maps over installed shadcn primitives; no supplied text becomes a class, style, id or prop. Buttons are `type="button"`, there is no `<form>`, no portaled overlay, and keydown (except Escape) stops at the preview root so app shortcuts do not fire. Concepts reuse the existing figure and Expand dialog; the grid responds to a container query, so the expanded dialog shows wider layouts. Local control state is uncontrolled and resets on reload/revision.

Not yet done at the time: viewport presets, density/typography tokens, feedback and Electron keyboard/theme qualification (see later phase notes). Verification: `pnpm typecheck`, `pnpm build`, new validator/tool/repository/renderer tests. Full suite: 2,712 passing, 95 skipped, 3 failing — the two known attachment-prompt assertions and `conversations.test.ts` reasoning-effort, which also fails without this change. A throwaway browser build of the real components at 420px and 1200px confirmed tab switching, the narrow grid stacking, and the two-pane expanded layout (light theme only).

### Phase B: Tool and local state

Register `present_ui` through the existing availability/effect/provider contracts. Carry server-owned identities through the shared artifact service. Add tabs, demo controls and bounded declared-state navigation using a small deterministic host reducer. Keep action capabilities out of this reducer.

Phase B implementation notes (2026-10-23):

`present_ui` registration landed with Phase A. Snapshots may declare up to 8 alternate `states` ({id, label, tree}); the snapshot `tree` is the reserved `initial` state. Buttons may carry `goTo`, validated up front against declared ids, and the 200-node budget is shared across all screens. The renderer's pure `conceptStateAfter` reducer only moves to declared ids (anything else is a no-op); a button's only possible behavior is that local transition. A host-owned header outside the concept frame announces the current state (`aria-live`) and offers "Reset preview". Each screen remounts on transition, so demo values and tabs start fresh; state is never persisted or sent to the agent, and a revision or reload resets to `initial`.

Verification: `pnpm typecheck`, `pnpm build`, new validator/reducer/renderer state tests. Full suite: 2,714 passing, 95 skipped, the same 3 pre-existing failures. A throwaway browser build confirmed a list/detail → reply → cancel flow at 420px; the state header was moved below the disclaimer after it crowded the note at narrow width.

### Phase C: Expanded preview and revision workflow

Add host-owned viewport presets, theme/density token handling and revision-aware rendering. Reuse existing artifact expansion rather than adding another panel system. Verify that live and restored UI concepts are identical apart from explicitly ephemeral local state. Add the optional explicit feedback action only with an existing safe user-turn delivery path or a narrowly tested extension.

Phase C implementation notes (2026-10-23):

Snapshots accept bounded `density` (compact/comfortable/spacious) and `typeScale` (sm/md/lg) tokens, and cards accept `surface` (default/muted). Tokens map to literal classes that override Tailwind's `--spacing` and `--text-*` variables on the preview frame only, so every spacing/text utility inside the concept rescales without touching app styles. The existing Expand dialog adds host-owned Fit/Mobile (375px)/Tablet (768px)/Desktop (1024px) width presets; the grid's container query follows the chosen width. The figure caption shows the exact revision. Reloaded and live concepts take the same exact-revision read path, so they render the same apart from ephemeral local state.

"Use this direction" uses the existing safe user-turn path instead of a new dispatch channel. `ArtifactChoiceContext` is provided only by the main conversation view. The button appends a host-authored `<user_design_choice artifact_id=… revision=…>` note to the composer, the same mechanism as terminal/file selections, and the user still sends it. The note carries only host-known identifiers and no concept text. It is deduplicated in the composer, and the button disables itself after use. Task/workflow readers have no provider and show no button. Mode prompts tell the agent this block is a chosen direction, not approval for edits or commands; later revisions still go through `present_ui` revision ownership checks.

Verification: `pnpm typecheck`, `pnpm build`, new token/preset/revision/choice tests. Full suite: 2,718 passing, 95 skipped, the same 3 pre-existing failures. A throwaway browser build confirmed the computed compact spacing (12.8px vs 16px) and small type (13px), the Mobile preset stacking the grid in the dialog, and the choice callback receiving the exact id/revision. Light theme only; no real-Electron keyboard pass yet.

### Phase D: Compatibility and usability qualification

Test representative settings, list/detail and dashboard redesign concepts. Compare whether the schema communicates meaningful alternatives, not just whether nodes render. Record cases that need code-preview fidelity rather than adding arbitrary escape hatches. Verify supported conversation/task/run readers and provider bridge exposure using PR115's compatibility rules; fallback must remain honest where the full renderer is unavailable.

Phase D implementation notes (2026-10-23):

Compatibility uses PR115's rules, extended to `present_ui`. OpenAI-compatible, Codex subscription and Claude subscription conversions preserve the concept schema (including `goTo`) and acknowledgements. The existing Gemini subset test already covers every built-in tool schema. Claude Code/Codex CLI bridges still reject presentation tools with explicit unknown-tool errors, so no CLI parity is claimed. Custom agents need the `presentation` category. Task and workflow readers render the exact concept revision outside collapsed traces. Real agent-loop tests persist and replay `present_ui` (with declared states) in Interactive and Chat modes with live/reload reference parity. Availability matches charts/tables in Chat, Interactive and North Star, and is withheld in plan mode, read-only turns and agents without the presentation category.

Repeatable real-Electron qualification: `node scripts/qualify-ui-concepts-electron.mjs` (set `UI_CONCEPT_SCREENSHOTS=<dir>` to keep screenshots). It builds real components and app CSS into a temporary directory and uses temporary user data. It renders representative settings (tabs, switch, input, select), list/detail (declared states), dashboard (grid of cards) and long-content concepts, plus an original and revised dashboard at 360px. Its 19 checks pass on Electron 37.10.3:
- layout: no page overflow at narrow width, with 500-character unbroken text, or at 125% root text; original revision still viewable beside its revision; type-scale token applied.
- local interaction: tabs, switch and demo-state survival across tabs; no `<form>`, navigation or transcript scroll change from local interaction; native arrow-key tab switching and native typing via `sendInputEvent`; keys never reach a window-level listener.
- states and dialog: declared-state transitions; Mobile preset width; dialog initial focus, Escape and focus return.
- feedback and themes: "Use this direction" reports the exact id/revision once; no re-reads during interaction; ≥4.5:1 text contrast in every concept in both light and dark themes.

Qualification found and fixed one defect: Radix unmounts inactive tab panels, so demo values reset on tab switch. Panels are now force-mounted and hidden.

Usability assessment: the vocabulary communicated the three representative redesigns. Separate artifacts plus revisions worked for alternatives, and declared states covered list→detail and form→confirmation flows. Cases that would need more fidelity (candidates for PR117 rather than schema growth): icons and images/avatars, sidebars and app-chrome navigation, overlays (menus, popovers, dialogs), brand colors/typefaces, per-breakpoint layout changes beyond the responsive grid, progress/meter visuals, and embedding PR115 charts (planned but not implemented, since no representative case needed it).

Qualification limitations: this is an isolated component check, not a packaged-app restart or live authenticated-provider campaign. Model-authored concept quality was not measured against live models. The shared `Switch` primitive mixed px track and rem thumb sizes, so its thumb overflowed at 125% root text app-wide; the track now uses rem sizes (identical at the default root size) and the qualification script checks thumb-in-track geometry at 100% and 125% in both states. Pointer hover/tooltip behavior and screen-reader output were not certified. Full suite: 2,723 passing, 95 skipped, the same 3 pre-existing failures; `pnpm typecheck`, `pnpm build` and `git diff --check` pass.

Follow-up (2026-10-23), alternatives in one artifact: user testing showed that "give me 4 concept ideas" produced four separate artifacts. A concept may now carry `alternatives` (2–6 items {id, label, description?, tree, states?}) instead of a top-level tree. Each alternative has its own 200-node budget and its own `goTo` targets, and the shared byte limit still applies. The figure shows a host-owned switcher. The inline view and the Expand dialog share the selection, and each alternative starts with fresh demo state. "Use “<label>”" adds `alternative_id`/`alternative_label` to the `<user_design_choice>` note. Choosing a different alternative replaces the earlier choice for the same artifact in the composer; other text in the draft is left untouched. Single-concept snapshots are unchanged. The tool description and mode prompts now direct multi-idea requests to one call. The concept disclaimer also now states that previews use North Star's own components, not the project's. Electron qualification adds alternatives switching, dialog sync and alternative choice (23 checks). Its contrast check now disables CSS transitions, because an occluded Electron window can leave table-row color transitions unfinished.

Likely new files are a UI-concept schema/validator and a registry/renderer/state adapter adjacent to PR115 modules, with narrow changes to the tool catalog, availability, prompts and artifact renderer. Names are proposed. No migration duplicating artifact storage and no edits to unrelated workspace screens are expected.

## Verification and acceptance

Schema tests cover unknown properties/types, bad child relationships, duplicate identifiers, excessive nodes/depth/options, cyclic-looking references, invalid declared-state targets, malformed chart/table content and script/HTML/URL-like text. Security regression tests assert that no arbitrary props, event handlers, HTML, style expressions, global selectors or tree-selected imports reach React components.

Renderer tests cover safe text, semantic headings/labels, local form isolation, tab/control behavior, state reset on revision, deterministic transitions, no agent turns for local clicks and no values leaking into persistence/feedback. Add focus/keyboard tests, missing/unknown-version fallback, revision history and live/reload parity. Feedback tests assert exact-revision identity, server ownership checks, explicit attribution, duplicate suppression and no approval authority.

In real Electron, inspect narrow and expanded widths, light/dark themes, enlarged text, keyboard navigation, focus restoration, long content and unchanged transcript scroll position. Exercise at least a settings redesign with tabs and controls, a list/detail concept with a supported local transition, and a revised alternative whose original remains viewable. Check that demo actions cannot submit chat or perform real operations.

Run targeted new artifact/tool/renderer tests plus existing transcript/approval regressions, then `pnpm typecheck`, `pnpm test` and `pnpm build` in the implementation session. Accepted when an agent can present and revise useful bounded concepts inline, supported interactions remain local, and neither preview code execution nor real application authority has been introduced.

## Explicit non-goals

No generated JavaScript/JSX/HTML execution, arbitrary CSS/Tailwind, general expression language, complete shadcn API exposure, credential forms, backend integrations, project dependency loading, automatic file edits or package installation, production code guarantees, replacement of app acceptance validation, or mandatory Mermaid removal. Questionnaire/clarification improvements are separate work. Use PR117's activation gate for fidelity requirements that exceed this bounded vocabulary.

## Sources and research limitations

The [shadcn component catalog](https://ui.shadcn.com/docs/components), installed UI inventory, transcript sources and PR115 informed this plan. Existing installed components are implementation resources, not evidence that every proposed composition, containment behavior or schema already exists. Registry API, state reducer and delivery paths require implementation-time verification. No concept renderer, tool, interaction tests or usability measurements were implemented by writing this document.
