# PR80: Semantic browser option selection and safe text entry

> Status: **COMPLETED**. Follow-up to `065`'s browser interaction tools. Adds one
> intent-level selection tool rather than separate tools for ARIA `combobox`,
> `listbox`, and `option` roles.

## Problem

The browser currently exposes low-level `browser_click` and `browser_type`
primitives. When a form contains a dropdown, an agent may click its trigger and
then type the desired option. `BrowserSession.type()` focuses the supplied node
and sends `Input.insertText` without first proving that the target is an editable
text control. On native selects and read-only/custom combobox triggers, text may
therefore be delivered to an unrelated previously focused field.

Tool descriptions alone cannot make this safe. The browser needs both a semantic
selection operation and a runtime guard that rejects invalid text targets.

## Product contract

Add this model-facing tool:

```ts
browser_select_option({
  ref: "e12",
  option: "Mexico",
})
```

- `ref` identifies the selection control from the most recent
  `browser_snapshot`. It may resolve to a native `<select>`, an ARIA combobox
  trigger/input, or a listbox. The model does not need different tools for those
  structural roles.
- `option` is the desired visible/accessibility label. Prefer an exact match
  after whitespace normalization; if none exists, case-insensitive equality is
  allowed only when it identifies exactly one option. Never silently use
  substring/fuzzy matching.
- The operation selects one enabled option, reports the resolved control and
  option, and returns the resulting URL/title/current value. It never falls back
  to typing into the page's current focus.
- Missing, disabled, or ambiguous options fail without making a selection and
  return a bounded list of available labels when the page exposes them.
- A page change invalidates refs exactly as it does for click/type. Stop and
  interaction deadlines remain effective across the whole compound operation.
- After every attempt that opens or changes a popup, rebuild/invalidate the ref
  map so later tools cannot act on the pre-interaction snapshot accidentally.

## Role-aware execution

Implement one `BrowserSession.selectOption(ref, option, ...)` entry point with
internal strategies selected from live DOM/accessibility metadata.

### Native `<select>`

- Resolve the ref to the actual select element and enumerate its options in DOM
  order, including label/text, value, disabled state, and current selection.
- Select the unique normalized label match. Dispatch bubbling `input` and
  `change` events so framework listeners observe the same committed value.
- Do not accept an arbitrary DOM selector or execute model-supplied JavaScript.
- Re-read the selected option after the events; report failure if the page
  rejected or immediately replaced the value.

### Custom combobox/listbox

- Determine whether the ref is an editable combobox, a read-only trigger, or an
  already-open listbox from the element tag, editability, `aria-expanded`,
  `aria-controls`/`aria-owns`, `aria-haspopup`, and AX role/state.
- If closed, activate the supplied control with the same real mouse-event path as
  `browser_click`, wait briefly for the popup, and rediscover the live options.
- Scope candidates to the controlled/owned popup when the page supplies that
  relationship. Otherwise prefer the newly opened visible listbox/menu surface
  and fail on ambiguity; never select an equal label from an unrelated control.
- Choose the unique visible enabled element with AX role `option`. Support
  `menuitemradio` only when it belongs to a control that clearly represents a
  value picker; ordinary action menus remain `browser_click` territory.
- Activate the option with real mouse events and verify through selected state,
  control value/text, or popup closure. Re-snapshot-worthy DOM changes must settle
  before returning.
- For an editable combobox, first look for an already rendered exact option. If
  filtering is required, focus and edit only the verified combobox input, then
  rediscover and click the exact option. A query is never considered a completed
  selection by itself.

Custom widgets with inaccessible markup may fail with an actionable diagnostic
and suggest a fresh snapshot, screenshot, ordinary click sequence, or user
handoff. They must not trigger speculative typing or a page-wide text search and
click.

## Text-entry guard

Harden `browser_type` independently of model behavior:

- Retain role/tag/editability metadata with every snapshot ref, or inspect it
  again immediately before typing.
- Allow text entry only for a live editable `<input>` text-like type,
  `<textarea>`, contenteditable element, or genuinely editable ARIA combobox.
- Reject native selects, buttons/read-only combobox triggers, listboxes, options,
  checkboxes, radios, and disabled/read-only fields before calling `DOM.focus` or
  `Input.insertText`.
- Return an error that names `browser_select_option` when the rejected target is
  a selection control. Do not use the page's pre-existing focus as a fallback.
- Preserve the existing `submit` approval semantics once the target passes the
  editability check.

## Snapshot affordances

Make selection behavior legible to the model without turning the snapshot into
an unbounded DOM dump. For interactive selection controls/options, include
bounded state when available:

```text
[e8] combobox: Country [collapsed, readonly, value="Canada"]
[e9] combobox: Assignee [expanded, editable]
[e10] option: Mexico [selected]
```

Relevant state is `expanded`/`collapsed`, `editable`/`readonly`, selected,
disabled, multiselect, and current value. These annotations also provide the
metadata used by the runtime guards; role alone is insufficient because an ARIA
combobox can be either an input or a button-like trigger.

Update the `browser_type` description to say it is only for editable text and to
direct dropdown choices to `browser_select_option`. Update `browser_click` to
recommend the selection tool for form values while retaining click as the
general escape hatch.

## Tool registration and capability policy

- Add the tool implementation beside the other browser tools and register it in
  `browserToolDefinitions`/tool dispatch.
- Extend `BrowserHandle` and its per-turn manager binding; keep all DOM/CDP work
  inside `BrowserSession` in the Electron main process.
- Add `browser_select_option` to the browser tool category and exact external
  capability mappings where a source offers equivalent structured select-option
  behavior. Do not map arbitrary Playwright/evaluate-code capabilities to it.
- Build a browser `ToolAction` containing origin, control fingerprint, normalized
  option label, and action type. Treat selection at least as strictly as
  `browser_click`: change/input handlers can autosave, navigate, or mutate remote
  state, so the new semantic path must not become an approval bypass.
- Approval identity must bind the stable target fingerprint and requested option,
  not only the ephemeral snapshot ref.

## Implementation seams

Expected touch points:

- `src/main/agent/tools/browser/select-option.ts`
- `src/main/agent/tools/index.ts`
- `src/main/browser/manager.ts`
- `src/main/browser/session.ts`
- `src/main/agent/agents/tool-categories.ts`
- `src/main/agent/agents/capability-policy.ts`
- `src/main/agent/approval/browser-classifier.ts`
- focused browser session, tool, capability, and approval tests

Prefer extracting shared click/focus/key/settle helpers from `BrowserSession`
over duplicating CDP event sequences. Keep the renderer and preload unchanged;
agent browser tools already reach the main-process browser through the per-turn
`BrowserHandle`.

## Verification

- A native single-select chooses the exact visible label, fires one observable
  input/change sequence, and reports the confirmed value.
- Closed and already-open custom listboxes select a unique option, including a
  portal-rendered popup associated through ARIA metadata.
- A searchable combobox filters only through its verified input and completes by
  activating an exact option; typed query text alone is not success.
- Missing, duplicate, disabled, unrelated same-label, stale-ref, popup-timeout,
  rerender, and cancellation cases fail deterministically without selecting or
  typing elsewhere.
- `browser_type` rejects a native select, read-only combobox trigger, listbox,
  option, and ordinary button before any input event, while text inputs,
  textareas, contenteditable controls, and editable combobox inputs still work.
- Selection actions carry target-and-option-bound approval identities and cannot
  receive a weaker decision than the equivalent click.
- Existing navigation/snapshot/click/type/wait/handoff flows stay green.
- Focused Vitest suites, `pnpm typecheck`, and `pnpm build` pass.

## Out of scope

- Separate public tools for `combobox`, `listbox`, or `option` roles.
- Multi-select add/remove/replace semantics, tag/chip pickers, hierarchical tree
  selectors, date/time pickers, color pickers, file uploads, and action menus.
- Fuzzy/semantic option matching, arbitrary selectors, model-supplied page code,
  or a full Playwright compatibility layer.
