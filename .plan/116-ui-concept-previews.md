# PR116: Constrained UI concept previews in conversation

> Status: **Proposed — not implemented.** Next up after [PR115: inline analysis artifacts](115-inline-analysis-artifacts.md), whose durable artifact, revision and transcript contracts this plan reuses. Higher-fidelity code previews are separately [deferred in PR117](117-sandboxed-html-react-previews.md).

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

### Phase B: Tool and local state

Register `present_ui` through the existing availability/effect/provider contracts. Carry server-owned identities through the shared artifact service. Add tabs, demo controls and bounded declared-state navigation using a small deterministic host reducer. Keep action capabilities out of this reducer.

### Phase C: Expanded preview and revision workflow

Add host-owned viewport presets, theme/density token handling and revision-aware rendering. Reuse existing artifact expansion rather than adding another panel system. Verify that live and restored UI concepts are identical apart from explicitly ephemeral local state. Add the optional explicit feedback action only with an existing safe user-turn delivery path or a narrowly tested extension.

### Phase D: Compatibility and usability qualification

Test representative settings, list/detail and dashboard redesign concepts. Compare whether the schema communicates meaningful alternatives, not just whether nodes render. Record cases that need code-preview fidelity rather than adding arbitrary escape hatches. Verify supported conversation/task/run readers and provider bridge exposure using PR115's compatibility rules; fallback must remain honest where the full renderer is unavailable.

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
