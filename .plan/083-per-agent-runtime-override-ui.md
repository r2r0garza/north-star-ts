# PR83: Per-agent runtime override UI

> Status: **COMPLETED**. Adds UI for per-phase-agent provider/model overrides using the existing `process_phase_agents.runtime_config` persistence.
>
> Implementation notes: Task 1 found the save path was NOT already complete — there was no phase-agent update at any layer (only create/delete), so `updatePhaseAgent` (repository), `db:processes:agents:update` (IPC) and `agents.update` (preload) were added; it patches only `runtime_config`, leaving skills/tools/identity untouched, and `null` clears the override. Each pool agent now renders an inline "Agent worker runtime" `RuntimePicker` (no Advanced disclosure, no separate inherit/override badge — the picker reads "Inherit" or the model name); it is hidden when no providers exist and on sub-process phases, whose pool never runs as workers. A deleted account degrades to the raw `account / model` ids. **Unplanned fix:** `resolveRuntime` let non-worker slots fall back to `config.worker`, and the decomposer/validator call sites passed the phase agent, so an agent worker override would have leaked into the decomposer and reviewer. The agent override now applies to the `worker` slot only and those call sites no longer pass the agent. Tests: service precedence (agent > phase > run, snapshot source `phase_agent`) plus a validator no-leak regression, repository update/clear, and builder UI (default, stored, deleted account, hidden cases, save, clear). `pnpm typecheck`, the full `pnpm test` suite and `pnpm build` pass. Manual `pnpm dev` validation (Task 6) was not run.

> **For Hermes:** Implement with the `north-star-project` and `test-driven-development` skills. Do not commit unless the user explicitly asks.

**Goal:** Add UI for configuring provider/model overrides on individual phase-pool agents, backed by the existing `process_phase_agents.runtime_config` persistence.

**Architecture:** Keep the current runtime precedence intact: phase-agent override > phase override > run default > source/global fallback. Add focused UI controls inside the phase agent/pool editor that write `runtimeConfig.worker` for each `ProcessPhaseAgent`.

**Tech Stack:** Electron + React + TypeScript, existing provider model catalog from `window.cowork.providers.listWithModels()`, existing process repositories/import-export runtime config support.

---

## Current Context / Assumptions

- DB/runtime/import-export already supports `process_phase_agents.runtime_config`.
- Execution path already reads phase-agent runtime overrides before phase/run defaults.
- The missing piece is a rich editor in `src/renderer/src/components/process-screen.tsx` for each phase agent row/card.
- Phase-level runtime controls already exist and can be reused as design/reference.

## Proposed Approach

1. Locate phase-agent/pool editing UI in `ProcessBuilder` / `PhaseCard`.
2. Reuse the existing `RuntimePicker` component/helper for each agent’s worker runtime.
3. Persist agent runtime config through the existing phase-agent update/create path.
4. Add tests for rendering, updating, and preserving inherited state.

## Files Likely To Change

- Modify: `src/renderer/src/components/process-screen.tsx`
- Modify: `src/renderer/src/components/process-screen.test.tsx`
- Maybe modify: `src/preload/index.ts` if phase-agent update input type does not expose `runtimeConfig`
- Maybe modify: `src/main/ipc/process-handlers.ts` if IPC validation/input type does not pass agent runtime config through
- Maybe modify: `src/main/db/repositories/processes.ts` only if update path lacks `runtimeConfig` support

## Step-by-Step Plan

### Task 1: Verify phase-agent update path

**Objective:** Confirm renderer can save `ProcessPhaseAgent.runtimeConfig` without adding new IPC channels.

**Files:**
- Inspect: `src/preload/index.ts`
- Inspect: `src/main/ipc/process-handlers.ts`
- Inspect: `src/main/db/repositories/processes.ts`
- Inspect: `src/renderer/src/components/process-screen.tsx`

**Steps:**
1. Search for phase-agent create/update handlers and renderer callers.
2. Confirm `runtimeConfig` is included in TypeScript input types.
3. If missing, extend the existing input type only; do not create duplicate save APIs.

**Verification:**
- You can trace UI save -> preload -> IPC -> repository -> DB column.

### Task 2: Add failing UI test for agent override visibility

**Objective:** Capture the missing UI behavior before implementation.

**Files:**
- Modify: `src/renderer/src/components/process-screen.test.tsx`

**Test case:**
- Render a phase with at least one phase agent and providerModels available.
- Assert an agent-level runtime picker/label exists, e.g. `Agent runtime` or `Worker model` inside the agent row.
- Assert default state is inherit.

**Command:**
```bash
pnpm vitest run src/renderer/src/components/process-screen.test.tsx
```

Expected before implementation: FAIL because no per-agent runtime control exists.

### Task 3: Render per-agent worker runtime picker

**Objective:** Let users set a specific model/provider for each phase agent.

**Files:**
- Modify: `src/renderer/src/components/process-screen.tsx`

**Implementation notes:**
- Reuse the existing provider/model picker rather than introducing a second UI pattern.
- Label should make precedence clear, e.g. `Agent worker runtime` with helper text `Overrides phase/run defaults for this agent only`.
- Store only `runtimeConfig.worker` initially; leave router/decomposer/validator at phase-level because those are orchestration slots, not individual worker slots.

**Acceptance Criteria:**
- Each configured phase agent can independently select provider/model or inherit.
- Inherit clears `runtimeConfig.worker` rather than writing empty IDs.

### Task 4: Save agent runtime config

**Objective:** Persist per-agent runtime selections.

**Files:**
- Modify: `src/renderer/src/components/process-screen.tsx`
- Maybe modify: `src/preload/index.ts`
- Maybe modify: `src/main/ipc/process-handlers.ts`

**Steps:**
1. Update the local phase-agent state shape to include `runtimeConfig`.
2. Include `runtimeConfig` in save payloads for existing and new agents.
3. Preserve unchanged skills/tools/role fields.
4. Ensure deleting/clearing a selection sends `null` or omitted config according to repository convention.

**Acceptance Criteria:**
- Reloading the builder shows the selected agent runtime.
- Exported process includes agent `runtimeConfig` for that agent.

### Task 5: Add execution precedence regression test if missing

**Objective:** Ensure agent override beats phase override and run default.

**Files:**
- Modify: `src/main/tasks/process/service.test.ts`

**Test case:**
- Configure run default = model A.
- Configure phase worker = model B.
- Configure phase agent worker = model C.
- Start/run enough of the process to assert worker conversation/task uses model C and phase-run snapshot source is `phase_agent`.

**Command:**
```bash
pnpm vitest run src/main/tasks/process/service.test.ts -t "phase agent runtime"
```

### Task 6: Manual validation

**Objective:** Verify from the product surface.

**Steps:**
1. Run `pnpm dev`.
2. Open a process with a phase using multiple agents.
3. Set one agent to OpenRouter/model X and another to inherit or a different model.
4. Start a run.
5. Verify provider logs and runtime snapshots show the per-agent selection.

## Tests / Validation

Run:
```bash
pnpm vitest run src/renderer/src/components/process-screen.test.tsx
pnpm vitest run src/main/tasks/process/service.test.ts
pnpm vitest run src/main/process/io.test.ts
pnpm run typecheck
pnpm run test
pnpm run build
```

## Risks / Tradeoffs

- The agent editor could get crowded. Keep controls collapsed or compact if needed.
- Per-agent overrides should be limited to worker runtime initially; orchestration slots belong at phase/run levels.
- Deleted provider accounts must degrade gracefully by displaying stored raw provider/model metadata.

## Open Questions (resolved)

- Inline by default, not behind an `Advanced` disclosure.
- No separate inherit/override badge; the picker value itself shows which.
