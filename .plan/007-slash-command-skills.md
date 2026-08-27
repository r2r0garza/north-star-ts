# Slash commands — user-invoked skills (`/skill-name …`)

> Status: **PARTIALLY SHIPPED**. Commit `c5594a1` added `skills:list`, composer autocomplete,
> keyboard selection, slash badges, and send-time rewriting to `<name> skill`. Still required to
> complete this plan: deterministic `read_skill(name)` pre-injection in main, authoritative unknown-
> skill validation, and persistence of the literal slash command while the model receives only its
> remainder.

## Context

Today skills are **model-discretionary**: each turn, `runChat` loads skills
(`src/main/agent/skills/loader.ts`), lists their name+description in the system prompt
(`skills/prompt.ts` → `buildSkillsPrompt`), and the model *decides* whether to call
`read_skill(name)` to pull a skill's body and follow it (`skills/tool.ts`). The user has no way to
say "definitely use this skill" — they can only phrase a message and hope the model picks it.

We want both paths:
- **Manual:** the user types `/skill-name do the thing` and the named skill is **forcibly**
  invoked — its instructions are guaranteed in context before the model acts on the request.
- **Automatic (unchanged):** the user types `do the thing` and the model calls a skill itself if
  one fits, exactly as today.

This is a power-user affordance (discoverability + determinism) that doesn't change the default
behavior. Skill names are already stable kebab-case identifiers (validated in
`loader.ts`/`types.ts`), so they map cleanly to `/name` tokens.

## Key facts established by exploration

- **No skill metadata reaches the renderer.** There's no `window.cowork.skills.*` channel; the
  composer (`src/renderer/src/App.tsx`) is a plain textarea with no slash/autocomplete handling.
  A new read-only IPC channel is needed for the picker.
- **`ChatRequest`** = `{ conversationId, message, workspace?, attachments? }` (in `src/preload/
  index.ts` and `src/main/agent/index.ts`). The renderer calls `window.cowork.chat(req, onEvent)`.
- **`read_skill` is built per-chat**, closing over that turn's loaded skills, and is dispatched
  *directly* (not via the static registry) in the tool loop
  (`agent/index.ts`, `call.name === readSkillTool.definition.function.name ? …`). Its
  `execute({ name })` returns the skill body or a "not found + available skills" error.
- **`tool_choice` is unused** anywhere — all tools are optional today.
- **Messages are assembled fresh each turn** via `contextBuilder.build(...)`, then appended to as
  tools run — so injecting a pre-executed tool call into the array is natural and low-risk.

## Recommended approach

### A. Forcing mechanism — pre-inject a `read_skill` call (NOT `tool_choice`)

When a turn is forced to skill `X`, **synthesize the `read_skill(X)` round-trip before the model's
first inference**, so the model starts with the skill body already in context and proceeds to act:

1. After loading skills, resolve `X`. If unknown, fail clearly (see §E).
2. Append to `messages` an assistant turn with a `tool_calls: [{ read_skill, arguments:
   {name:"X"} }]` (a fresh `randomUUID()` id), then the matching `tool` message whose content is
   `await readSkillTool.execute({ name: "X" }, ctx)` (reusing the existing tool — single source of
   truth for the body + not-found text).
3. Persist both (assistant tool-call + tool result) like any other tool turn, so the transcript
   shows the forced read and history replays correctly.
4. Let the loop run as normal — the model now has the instructions and the user's request.

Why this over `tool_choice: {function:{name:"read_skill"}}`: `tool_choice` only forces *a*
read_skill call but lets the model choose the `name` argument (it could read the wrong skill), and
it depends on Portkey forwarding the parameter. Pre-injection is deterministic, reuses the shipped
tool, needs no API-surface assumptions, and matches how the loop already appends tool turns.

### B. Where to parse `/skill-name` — main process (`runChat`), with the renderer hinting

Parse authoritatively in `runChat`, not the renderer, so the rule is one place and the stored
message stays faithful. Add `forcedSkill?: string` to `ChatRequest`; the renderer sets it when it
recognizes a leading `/name` (it already needs the skill list for autocomplete), but `runChat`
also defensively parses a leading `/name` token from `message` if `forcedSkill` is absent. The
literal `/name ` prefix is stripped from the text the model sees; the **original** text
(with the slash) is what's persisted/displayed, so the transcript reflects what the user typed.

- Parse: `^/([a-z0-9-]+)(?:\s+([\s\S]*))?$` → `forcedSkill = group1`, `message = group2 ?? ""`.
- An empty remainder (`/skill-name` alone) is valid — force the skill with no extra instruction.

### C. Expose skill metadata to the renderer (new IPC)

- **`src/main/ipc/` ** — a `skills:list` channel returning `{ name, description, source }[]` via
  `loadSkills(skillSources(workspace))`. Takes an optional `workspace` so project-level skills show
  for workspace conversations. Register alongside the other handlers in `src/main/index.ts`.
- **`src/preload/index.ts`** — `window.cowork.skills.list(workspace?)`; re-export a
  `SkillSummary` type. (Read-only; never exposes the skill body — that still flows through
  `read_skill` during a turn.)

### D. Composer slash UI (`src/renderer/src/App.tsx`)

- On input starting with `/`, fetch+cache the skill list and show a filtered dropdown
  (name + description) above the textarea; ↑/↓ to move, Tab/Enter to complete to `/<name> `.
- On send, detect a leading `/<name>` and pass `forcedSkill` + the remainder as `message` (main
  re-validates). Match the existing component/styling conventions (the question-panel / approval
  popovers are nearby precedents). Reuse the dropdown primitive already in `components/ui/`.

### E. Unknown / ambiguous skill handling

- **Unknown `/name`:** don't silently send it as a prompt. `runChat` returns a clear error
  (mirrors `read_skill`'s "available skills: …" message) so the user learns the right name. The
  composer can also gray out / not auto-complete an unknown token.
- **`/` with no match while typing:** just show "no matching skills"; the user can still send it
  as literal text (a message that genuinely starts with `/` is rare, but if `forcedSkill` doesn't
  resolve, surface the error rather than guessing).

## Critical files

- New: `src/main/ipc/skills-handlers.ts` (or fold into an existing handler module),
  `src/renderer/src/components/skill-menu.tsx` (the autocomplete dropdown).
- Modified: `src/main/agent/index.ts` (`ChatRequest` + forced-skill pre-injection in `runChat`),
  `src/preload/index.ts` (`skills` namespace + `ChatRequest.forcedSkill` + types),
  `src/main/index.ts` (register the skills handler), `src/renderer/src/App.tsx` (composer parsing
  + dropdown wiring).
- Reuse: `loadSkills`/`skillSources` (`agent/skills/`), `createReadSkillTool().execute`
  (the body/not-found source of truth), the per-turn tool-append + persist pattern already in
  `runChat`'s tool loop.

## Open questions (decide before/while building)

1. **Forced-skill scope.** Does `/name` only force `read_skill`, or should it also constrain the
   turn (e.g. a system note "the user explicitly invoked the X skill; follow it")? Leaning: inject
   the read **plus** a short directive line, so the model treats it as authoritative, not optional
   context.
2. **Autocomplete depth for v1.** Full keyboard-nav dropdown, or a minimal "type the name, we
   validate on send" first cut with the dropdown as a fast-follow? Leaning: ship parsing +
   forcing + the `skills:list` channel first (the functional core), then the dropdown.
3. **Arguments convention.** Is everything after `/name` just free-text instruction (recommended),
   or do we ever want structured args? Leaning: free-text only — skills are prose instructions,
   not typed commands.
4. **Mode/workspace gating.** Skills already layer by workspace; should `/name` be offered in all
   modes (chat/interactive/north_star)? Leaning: yes, wherever skills load.

## Verification (when built)

- **Manual force:** `/some-skill do X` → the transcript shows a `read_skill(some-skill)` call +
  its body before the assistant acts, and the response follows the skill. No `/` prefix leaks into
  what the model is asked to do; the user's bubble still shows the text they typed.
- **Automatic path unchanged:** `do X` with no slash behaves exactly as today (model may or may
  not call a skill).
- **Unknown skill:** `/nope …` returns a clear "no such skill (available: …)" error, not a
  silent normal turn.
- **Empty remainder:** `/some-skill` alone forces the skill with no extra instruction.
- **Renderer:** typing `/` shows matching skills with descriptions; completing inserts `/<name> `.
- `pnpm typecheck`, `pnpm test`, `pnpm build` clean; `pnpm dev` exercises the composer end-to-end.

## Out of scope

- Slash commands that aren't skills (e.g. `/clear`, app commands) — this is skills-only.
- Editing/creating skills from the UI (a separate `skill_manager` effort in the backlog).
- Structured/typed skill arguments (free-text remainder only).
- Chaining multiple forced skills in one message.
