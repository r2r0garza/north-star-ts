# PR132: Default-agent custom instructions

> Status: Proposal only. Source analysis completed 2026-10-31. No application code changed. The scope choices below are recommendations, not approved implementation decisions.

## Objective

Let users personalize the built-in agents without creating a named agent. Treat default custom instructions and a named agent's body as alternative occupants of one instruction slot, never cumulative layers. Preserve North Star's built-in behavioral core, mode instructions, permissions, and tool restrictions.

## Recommendation

Start with one application-wide Markdown field, “Default agent instructions,” shared by Chat, Interactive, and North Star modes. This is a fallback persona/work-style preference, not universal instructions that also follow named agents. Mode-specific fields, workspace overrides, and conversation-level copies are unnecessary for the first version. Confirm the shared-field scope before implementation if separate customization for each mode is desired.

The effective base prompt is the selected instruction prefix, when present, followed by the existing built-in mode prompt. Select the prefix in this order: an explicit child instruction prefix; otherwise a resolved named agent's body; otherwise saved default instructions for an eligible built-in conversation; otherwise no prefix. Never combine the default instructions with either of the first two sources. Completion instructions and runtime context keep their existing roles.

Choosing a named agent replaces only this optional instruction layer, not the built-in system prompt. Clearing the named selection restores the saved default layer on the next turn. Selecting a named agent with an empty body still suppresses defaults: selection, not body truthiness, determines that branch. An empty or whitespace-only default field means no customization.

## What exists today

`src/main/agent/system-prompt.ts:57` loads and caches the shared behavioral core plus the selected mode's delta. Keep this cache independent of mutable user settings.

`src/main/agent/index.ts:1227` resolves the named agent each turn. A missing/unloadable selected definition currently resolves to the built-in agent. `index.ts:1600` already prepends either an explicit child prefix or the named agent's body, using an approved-instruction provenance envelope, to the non-droppable base prompt. This is the natural insertion point for the fallback; do not add another droppable context section.

The same `baseSystemPrompt` feeds initial context construction and in-turn compaction (`index.ts:1951`, `index.ts:2954`). Resolve customization once per turn so every model round and rebuild within that turn uses the same instructions. Read it again on the next turn rather than storing it in conversation history.

`src/main/settings/service.ts` persists typed settings in the existing key/JSON settings store, and `src/main/ipc/settings-handlers.ts` exposes them to the renderer. The settings screen already has Agent behavior → Behavior (`src/renderer/src/components/settings-screen.tsx`). No new database table, agent file format, dependency, or editable copy of a bundled prompt is needed.

## UI and persistence

Place a multiline editor in Agent behavior → Behavior with the label “Default agent instructions.” Suggested explanation: “Applied to North Star's built-in agents in Chat, Interactive, and North Star modes. A selected named agent uses its own instructions instead. Changes apply on the next turn; existing conversation history is retained.”

Reuse the surrounding settings save pattern and existing form controls. Clearing and saving disables customization; no separate enable switch is necessary. Preserve the draft on save failure and show an accessible error. Persist a separate typed settings value so unrelated conversation preferences cannot overwrite the text. Default to an empty string for old installations; use existing settings storage without a schema migration.

Validate type and an explicit finite size limit in the main process, with the same limit communicated by the UI. Choose that limit during implementation based on supported request budgets; do not silently truncate. This text is sent to the selected model and can appear in existing prompt logs: discourage passwords and secrets. It must not become a model-writable setting or an automatically imported instruction from repository files, tool output, or conversation recall.

## Trust and semantics

Reuse `renderContextEnvelope` from `src/shared/context-provenance.ts`, marking manually saved preferences as approved instructions with a stable source such as `default_agent_instructions`. Preserve the distinction from North Star's own system/runtime policy. Being physically prepended does not grant permission to override safety rules, approvals, tool access, confinement, or managed-policy constraints. Instructions can influence behavior; actual permissions remain enforced in code.

This eliminates competition between default preferences and named-agent instructions, not every possible instruction conflict. Skills, memory, project context, and explicit user requests still exist. Switching agents or clearing preferences does not erase prior responses, summaries, or already activated skills from an ongoing conversation. Recommend a new conversation when a user needs a clean behavioral slate; do not claim a hard reset.

## Execution boundaries

Apply the first version to North Star-managed user conversation turns, including plan mode and supported managed provider transports using this shared assembly path. Do not gate it on having a workspace: ordinary Chat must work too. Saving during an active turn takes effect on the following turn, without mutating an in-flight request.

Standalone `claude_code` and `codex_cli` accounts return before native prompt assembly (`src/main/agent/index.ts:1148–1211`). They own their own agent loops. Exclude those autonomous CLI providers from the first version and state that limitation in settings; do not silently promise universal support or splice North Star's full mode prompt into their prompts. Verify managed subscription transports separately rather than treating every Claude/Codex-branded account as the same backend.

Do not inject defaults into delegated children with explicit identity/profile instructions. Existing clone behavior copies a named parent's body, not its fully assembled system prompt (`index.ts:3740`); keep it unchanged rather than introducing default-persona inheritance. Exclude internal maintenance/model calls such as title generation and memory processing. Before implementing the fallback, audit headless/background/workflow callers so an absent agent alone cannot accidentally enable personal preferences in internal work. Recommended v1 scope excludes headless workers; any later background inheritance should be explicit.

For an unavailable named-agent definition, preserve today's built-in fallback and consequently use default instructions for an otherwise eligible conversation. Record/test this outcome; surfacing stale selection in the picker is a separate existing UX concern, not a prerequisite to this feature.

## Implementation touchpoints

The likely changes are settings service/defaults/validation and its tests; settings IPC plus preload and renderer type declarations (`src/preload/index.ts`, `src/renderer/src/types.ts`); the existing settings Behavior editor and its tests; and the prefix-selection branch and focused runtime tests in `src/main/agent/index.ts`. Inspect all `runAgentLoop` callers and execution flags before choosing the exact eligibility condition. Keep selection logic directly testable without introducing a broad prompt framework.

Do not modify bundled prompt Markdown or named-agent definitions. Do not create an agent catalog entry for the default persona. Reuse the existing non-droppable base so compaction cannot silently remove the user's preferences. Existing request-size handling must continue to apply; mandatory text can still exhaust a small model's budget, which is why a finite input limit and request-size checks matter.

## Verification and acceptance

Cover settings default/save/reload/clear, whitespace, invalid input and over-limit rejection, plus UI failure handling. Assert the final assembled prompt, not just the selected setting: defaults appear exactly once before the mode prompt in each built-in mode; absent defaults leave current behavior unchanged; named selection suppresses defaults even for an empty named body; deselection restores them; and an explicit child prefix wins over both. Preserve core/mode text and provenance envelopes in every case.

Cover edits between turns, stable instructions during a turn, in-turn compaction, unavailable-agent fallback, Chat without a workspace, plan mode, child runs, and exclusion of internal/headless callers. Verify the managed provider transports that consume this prompt, and the documented exclusion of autonomous CLI providers. Assert that tool permissions and approval behavior do not change.

Run focused settings/UI/runtime tests, typechecks, and build during implementation. Manually save, reopen settings, start a default-agent conversation, switch to a named agent, switch back, and inspect effective prompt logs using non-sensitive sample instructions. This proposal has not run application tests or live-model checks because no code was changed.

## Out of scope

Per-mode editors, workspace or per-conversation overrides, multiple instruction profiles, merging/inheriting defaults into named agents, automatic conflict detection, history resets, subagent inheritance changes, and autonomous CLI-provider parity. These can be considered later only if actual usage requires them.
