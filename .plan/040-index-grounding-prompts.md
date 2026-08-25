# PR40: Index-grounding guidance in the Interactive / North Star prompts

> Status: **PROPOSED** (not started).
> Small prompt change plus an optional priority tweak. Builds on the plan-008 workspace
> index (`index_query_tool`, `buildIndexSummary`) and plan-014's `ContextBuilder` section
> budgeting. No schema or code-path changes required for the core of it.

## Context

**The gap:** the two workspace-backed agents don't have any standing instruction to orient
themselves via the workspace index before doing broad file walks. Their persistent mode
prompts — `prompts/interactive-system-prompt.md` and `prompts/north-star-system-prompt.md` —
say nothing about the index, `index_query_tool`, or grounding; they only give generic
"explore the workspace" guidance.

Today the *only* index-grounding language reaches the model through two **dynamic** channels,
both gated on the "use index for context" setting **and** a workspace that has actually been
indexed:

1. The injected **`## Workspace index`** context section — `buildIndexSummary()` in
   `src/main/index/summary.ts`. Its closing line already tells the agent: *"Use
   index_query_tool to find symbols, list files… use the normal file tools for exact reads and
   full-text search. The index may be partial or stale — treat misses as 'not indexed yet',
   not 'does not exist'."*
2. The **`index_query_tool`** description (`src/main/agent/tools/index_query_tool.ts:27-34`):
   "Query the workspace index for fast orientation… advisory and may be partial or stale."

The problem with relying only on those: the summary section is the **most droppable** of all
context sections (`SECTION_PRIORITY.index = 10` in `context/context-builder.ts`), so under
budget pressure it's the first thing cut — and it's absent entirely until the index exists.
So exactly when the agent would benefit most from being told "orient via the index first,"
the guidance may not be present.

**Intended outcome:** a short, *always-present* line in each workspace-backed mode prompt that
steers the agent to consult `index_query_tool` for cheap orientation (symbols, file lists,
importers) before broad `search_tool`/manual walks — while preserving the existing "advisory,
may be stale, misses ≠ absent" caveat so the agent still trusts the real file tools as
authoritative.

## Approach

Primarily a **prompt edit** (behavioral guidance belongs in the mode deltas, per the
architecture note in `system-prompt.ts:5-16` — tools/dynamic facts are deliberately kept out
of the static prompt, but standing *behavior* is exactly what these deltas are for).

### 1. Add an orientation line to both workspace-backed mode prompts
- `prompts/interactive-system-prompt.md` and `prompts/north-star-system-prompt.md`.
- One sentence, phrased as behavior not a tool spec (the tool's own definition remains the
  source of truth — don't restate its parameters). Something like: *"When a workspace index is
  available, prefer `index_query_tool` for fast orientation — finding symbols, listing files,
  or seeing what imports a module — before broad searches or manual walks; fall back to the
  normal file tools for exact reads and full-text search, and treat an index miss as 'not
  indexed yet', not 'absent'."*
- **Do NOT touch** `prompts/chat-system-prompt.md` — Chat mode is workspace-less and has no
  index (`index_query_tool` isn't even in its tool set).
- Word it conditionally ("when a workspace index is available") so it reads correctly even
  when the index setting is off or nothing is indexed yet — the agent simply won't have the
  tool in those turns.

### 2. (Optional, decide at execution) make the index summary less droppable
- If we want the *dynamic* summary to survive budget pressure more often, bump
  `SECTION_PRIORITY.index` in `src/main/agent/context/context-builder.ts` above
  `environment` (currently `index: 10`, `environment: 5`) — or higher. Keep it below
  `approvals`/`todos`/`skills` so it never starves the plan or capability list.
- Lean toward **leaving priorities as-is** for this PR: the static prompt line is the durable
  fix; the summary staying "most droppable" is by design (it's the cheapest to regenerate and
  the least essential). Only raise it if live testing shows the orientation guidance is
  getting dropped when it matters.

## Files to modify

- `prompts/interactive-system-prompt.md` — add the orientation sentence.
- `prompts/north-star-system-prompt.md` — add the orientation sentence (matching wording).
- (optional) `src/main/agent/context/context-builder.ts` — `SECTION_PRIORITY.index` bump.

## Reuse / existing patterns

- `system-prompt.ts` composes `_core/behavior.md` + the per-mode delta and **caches per mode**
  — no code change needed; editing the `.md` is picked up on next load (a dev reload / app
  restart clears the in-process cache).
- The caveat wording should mirror the existing advisory line in `buildIndexSummary()`
  (`src/main/index/summary.ts:88-92`) so the static prompt and the dynamic section say the
  same thing rather than drifting.
- Mode gating for the index is already handled in `runChat` (`src/main/agent/index.ts:444-463,
  546-555`): `index_query_tool` and the summary section are only present when `useIndex` and a
  workspace/indexed run exist. The prompt line's "when available" phrasing aligns with that.

## Verification

1. `pnpm typecheck` (no-op for prompt-only edits, but run if the priority bump is included).
2. Manual, Interactive mode: open an **indexed** workspace, enable "use index for context,"
   send a question that needs orientation (e.g. "where is X defined?"). With
   `settings.logSystemPrompt` on (`src/main/agent/index.ts:606`), confirm the new line appears
   in the composed system block, and observe the agent reaching for `index_query_tool` before
   a broad `search_tool` sweep.
3. Manual, North Star mode: same check on an autonomous task.
4. Negative check: **Chat** mode prompt is unchanged and contains no index language; a
   workspace-less turn composes without the index tool/section and the new line reads
   sensibly (it's conditional, so it shouldn't mislead).
5. If the priority bump is included: on a long conversation that previously dropped the
   `## Workspace index` section, confirm the `[context] sections:` debug line now admits it
   (or intentionally still drops it below the higher-priority sections).
