# PR84: Import account remapping UX

> Status: **PLANNED**. Adds a process import remapping step for runtime configs whose provider accounts/models differ on the local machine.

> **For Hermes:** Implement with the `north-star-project` and `test-driven-development` skills. Do not commit unless the user explicitly asks.

**Goal:** When importing a process with runtime configs from another machine/profile, provide a clear UX to map imported provider/model selections to local provider accounts and models.

**Architecture:** Keep exported process JSON portable and id-free where possible, but treat account IDs as machine-local. During import, detect runtime selections that cannot be resolved locally and offer remapping before creating the final process definition.

**Tech Stack:** Electron + React + TypeScript, SQLite repositories, existing process import/export in `src/main/process/io.ts`, existing provider catalog from `providers.listWithModels()`.

---

## Current Context / Assumptions

- Import/export already preserves `runtimeConfig` on phases and phase agents.
- Local account IDs are not portable between installations/profiles.
- A process can contain runtime selections at run/phase/phase-agent levels with slots: `worker`, `router`, `decomposer`, `validator`.
- The current import flow likely accepts JSON and writes definitions without a dedicated remapping step.

## Proposed Approach

1. Add import analysis that scans all runtime selections before write.
2. Classify each selection as resolved, provider/model-matchable, or unresolved.
3. Expose a UI step where users can map unresolved selections to local account/model entries or choose inherit.
4. Apply mappings during import, then persist the adjusted runtime config.

## Files Likely To Change

- Modify: `src/main/process/io.ts`
- Modify: `src/main/process/io.test.ts`
- Modify: `src/main/ipc/process-handlers.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/components/process-screen.tsx`
- Maybe create: `src/main/process/runtime-remap.ts` if import analysis becomes large enough to split

## Step-by-Step Plan

### Task 1: Define remap analysis types

**Objective:** Represent imported runtime selections and local resolution state.

**Files:**
- Modify: `src/main/process/io.ts` or create `src/main/process/runtime-remap.ts`
- Modify: `src/main/db/types.ts` only if shared exported types are needed

**Suggested shape:**
- `ImportedRuntimeReference`: process/phase/agent path, slot, provider, accountId, modelId.
- `RuntimeReferenceResolution`: `resolved | model_match | provider_match | unresolved`.
- `RuntimeImportMapping`: original reference key -> local `accountId/modelId/provider` or inherit.

**Acceptance Criteria:**
- Types can identify exactly which imported field needs remapping.

### Task 2: Add tests for import analysis

**Objective:** Detect unresolved account IDs before import writes data.

**Files:**
- Modify: `src/main/process/io.test.ts`

**Test cases:**
1. Same local account/model resolves automatically.
2. Different account ID but same provider/model produces a match suggestion.
3. Missing provider/model is unresolved.
4. User chooses inherit and runtime config is cleared for that slot.

**Command:**
```bash
pnpm vitest run src/main/process/io.test.ts
```

### Task 3: Implement runtime reference scan

**Objective:** Traverse exported process JSON and collect all runtime selections.

**Files:**
- Modify: `src/main/process/io.ts` or create `src/main/process/runtime-remap.ts`

**Steps:**
1. Scan each phase `runtimeConfig` slot.
2. Scan each phase agent `runtimeConfig` slot.
3. Include stable display path metadata: phase key/name, agent name, slot.
4. De-duplicate identical references but retain all usage paths for UI context.

**Acceptance Criteria:**
- Scan output includes every imported runtime selection exactly once per unique local mapping need.

### Task 4: Add IPC/preload import analysis entrypoint

**Objective:** Let renderer preview mapping needs before committing import.

**Files:**
- Modify: `src/main/ipc/process-handlers.ts`
- Modify: `src/preload/index.ts`

**Possible API:**
- `window.cowork.process.analyzeImport(input)` -> analysis result
- `window.cowork.process.import(input, { runtimeMappings })` -> final import

**Acceptance Criteria:**
- Renderer can call analysis without writing DB rows.
- Existing direct import path still works for fully resolved imports.

### Task 5: Add remapping modal/step in process import UI

**Objective:** Give users a friendly mapping screen.

**Files:**
- Modify: `src/renderer/src/components/process-screen.tsx`

**UI behavior:**
1. User selects/imports process JSON.
2. App analyzes runtime references.
3. If all resolved, import proceeds normally.
4. If unresolved/matchable, show a mapping modal/table.
5. For each imported reference, user chooses local provider/model or `Inherit`.
6. Import applies selected mappings.

**Acceptance Criteria:**
- Users never see raw SQLite/account-ID failures.
- Imported process is usable immediately on the local machine/profile.

### Task 6: Preserve auditability in imported configs

**Objective:** Keep imported intent inspectable even after remapping.

**Files:**
- Modify: `src/main/process/io.ts`

**Implementation notes:**
- Consider storing original imported provider/model as optional metadata if runtime selection type allows it.
- Do not block import solely because original account ID is unknown.
- Prefer local account/model IDs in executable runtime config.

### Task 7: Manual validation

**Objective:** Simulate cross-machine import.

**Steps:**
1. Export a process with OpenRouter runtime selections.
2. Edit/copy the JSON so account IDs do not match local accounts.
3. Import it.
4. Confirm remap UI appears.
5. Map to a local OpenRouter account/model.
6. Start a run and confirm selected local model is used.

## Tests / Validation

Run:
```bash
pnpm vitest run src/main/process/io.test.ts
pnpm vitest run src/renderer/src/components/process-screen.test.tsx
pnpm run typecheck
pnpm run test
pnpm run build
```

## Risks / Tradeoffs

- Fully automatic matching can be wrong if multiple accounts expose the same model ID; require user confirmation when ambiguous.
- Account IDs should not be treated as portable identifiers.
- Keep import usable even when no providers are configured by allowing `Inherit`.

## Open Questions

- Should remap choices be remembered per provider/model for future imports?
- Should import fail for unresolved runtime references, or always allow inherit fallback?
- Should exported runtime configs include provider display names for friendlier mapping labels?
