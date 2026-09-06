# PR82: Runtime-aware run monitor badges

> Status: **PLANNED**. Fixes the misleading provider/model badge in the Process run monitor by rendering from `runtime_snapshot` when available.

> **For Hermes:** Implement with the `north-star-project` and `test-driven-development` skills. Do not commit unless the user explicitly asks.

**Goal:** Make running/completed process UI badges reflect the actual runtime provider/model used, not the old/default agent badge path.

**Architecture:** Use the existing `process_phase_runs.runtime_snapshot` field as the source of truth for model/provider display. Keep execution logic unchanged; this is a UI/diagnostic accuracy pass with tests around snapshot display fallback behavior.

**Tech Stack:** Electron + React + TypeScript, Vitest, existing North Star process DB/repository types.

---

## Current Context / Assumptions

- Runtime execution selection is already working; OpenRouter logs can show the selected model even when the monitor badge still says Claude.
- Runtime snapshots are persisted on `ProcessPhaseRun.runtimeSnapshot` / DB column `process_phase_runs.runtime_snapshot`.
- Renderer process types are exported through `src/renderer/src/types.ts` and used in `src/renderer/src/components/process-screen.tsx`.
- Existing badge UI lives in `src/renderer/src/components/process-screen.tsx`; search for `Badge`, `RunMonitor`, and `ProcessPhaseRun`.

## Proposed Approach

1. Add a small display helper that derives a runtime badge label from a phase run snapshot and provider/model catalog.
2. Prefer `runtimeSnapshot.<slot>` values over legacy/default badge values.
3. Preserve existing fallback behavior when snapshot is absent, because old runs will not have runtime snapshots.
4. Add tests that render phase run data with a runtime snapshot and assert the displayed provider/model is the selected one.

## Files Likely To Change

- Modify: `src/renderer/src/components/process-screen.tsx`
- Modify: `src/renderer/src/components/process-screen.test.tsx`
- Maybe modify: `src/renderer/src/types.ts` only if runtime snapshot typing is incomplete

## Step-by-Step Plan

### Task 1: Locate current badge rendering

**Objective:** Identify the exact UI branch that renders the misleading Claude badge.

**Files:**
- Inspect: `src/renderer/src/components/process-screen.tsx`

**Steps:**
1. Search for `Badge`, `agent`, `provider`, and `RunMonitor` in `process-screen.tsx`.
2. Identify which phase-run/agent fields currently produce the Claude badge.
3. Confirm whether `runtimeSnapshot` is already present in the `ProcessPhaseRun` object reaching the monitor.

**Verification:**
- You can point to the exact component/function rendering the stale badge.

### Task 2: Add runtime badge helper

**Objective:** Centralize display behavior for provider/model labels.

**Files:**
- Modify: `src/renderer/src/components/process-screen.tsx`

**Implementation notes:**
- Add helper near existing runtime helpers such as `runtimeSelectionLabel`.
- Inputs should include:
  - `phaseRun.runtimeSnapshot`
  - desired slot, normally `worker`
  - `providerModels`
- Output should include enough display state for a badge:
  - provider/account label
  - model label
  - source, e.g. `phase`, `run`, `source_conversation`, `default`
- Fallback to current badge behavior if no snapshot exists.

**Acceptance Criteria:**
- Existing runs without snapshots still render a sensible badge.
- New runs with snapshots display selected provider/model.

### Task 3: Wire helper into run monitor phase rows/cards

**Objective:** Replace stale provider/model badge rendering with snapshot-aware display.

**Files:**
- Modify: `src/renderer/src/components/process-screen.tsx`

**Steps:**
1. In the run monitor phase rendering path, compute runtime display from `phaseRun.runtimeSnapshot?.worker`.
2. Render provider/model in the badge or adjacent compact text.
3. If source is not too noisy, expose it in a tooltip/title, e.g. `Runtime source: phase`.
4. Avoid changing execution state or repository calls.

**Acceptance Criteria:**
- Manual run with a phase worker override no longer shows Claude if OpenRouter was selected.
- Badge text is understandable even when model IDs are long.

### Task 4: Add regression tests

**Objective:** Prevent UI from regressing to stale/default provider display.

**Files:**
- Modify: `src/renderer/src/components/process-screen.test.tsx`

**Test cases:**
1. A phase run with `runtimeSnapshot.worker.provider = "openai_compatible"` and an OpenRouter model displays OpenRouter/model text.
2. A phase run without runtime snapshot falls back to the existing legacy badge path.
3. Long model IDs are rendered without crashing; exact truncation CSS does not need brittle assertions.

**Commands:**
```bash
pnpm vitest run src/renderer/src/components/process-screen.test.tsx
pnpm run typecheck
```

### Task 5: Manual validation

**Objective:** Prove UI matches actual execution.

**Steps:**
1. Run `pnpm dev`.
2. Start a process with a phase worker override to OpenRouter.
3. Confirm OpenRouter logs show the request.
4. Confirm the run monitor badge displays OpenRouter / selected model, not Claude.
5. Open an older run if available and confirm it still renders.

## Tests / Validation

Run:
```bash
pnpm vitest run src/renderer/src/components/process-screen.test.tsx
pnpm run typecheck
pnpm run test
pnpm run build
```

## Risks / Tradeoffs

- Provider/account labels may be unavailable if account was deleted or disabled; fallback should show raw provider/model from snapshot.
- Historical runs may not have snapshots; keep fallback behavior to avoid blank badges.
- Avoid overloading the badge with every slot. Start with worker; add router/decomposer/validator details in expanded diagnostics later if needed.

## Open Questions

- Should the badge show only worker runtime, or also expose router/decomposer/validator in a detail panel?
- Should the source (`phase`, `run`, `default`) be visible by default or only in tooltip/detail text?
