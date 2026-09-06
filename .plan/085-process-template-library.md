# PR85: Process template library

> Status: **PLANNED**. Adds a built-in template library so users can create useful starter Processes instead of beginning from a blank builder.

> **For Hermes:** Implement with the `north-star-project` and `test-driven-development` skills. Do not commit unless the user explicitly asks.

**Goal:** Add a polished built-in process template library so new users can start from useful workflows instead of a blank Process builder.

**Architecture:** Store templates as versioned data definitions that import through the same process definition path as user exports. Keep templates portable, runtime-config-aware, and safe to instantiate repeatedly without mutating the template source.

**Tech Stack:** Electron + React + TypeScript, existing process import/export model, SQLite process repositories, Vitest.

---

## Current Context / Assumptions

- Processes are North Star’s primary differentiator, so onboarding templates matter.
- Import/export already creates portable process definitions with phases, agents, edges, runtime config, completion contracts, and subprocess references.
- There is no polished built-in template catalog yet.
- Templates should not require the direct ChatGPT/Codex backend work.

## Proposed Approach

1. Define a template format that is either exactly `ProcessExport` plus metadata or a thin wrapper around it.
2. Add several high-value starter templates for common workflows.
3. Add a template browser/chooser in the Processes UI.
4. Instantiate templates by feeding the definition through the existing import/create path.
5. Include runtime config guidance without hard-requiring a specific local account.

## Candidate Starter Templates

Start with a small, high-quality set:

1. **Research Brief**
   - Phases: gather context -> synthesize findings -> validate sources -> final brief.
   - Good for demonstrating fan-out + validator.

2. **PR Review / Code Quality Pass**
   - Phases: inspect diff -> parallel specialist review -> consolidate findings -> final recommendations.
   - Good for developers and agent workflows.

3. **Bug Triage and Fix Plan**
   - Phases: reproduce/understand -> root cause -> proposed fix -> verification checklist.
   - Good for showing process auditability.

4. **Content Pipeline**
   - Phases: outline -> draft -> editor review -> final publish checklist.
   - Good for non-code users.

5. **Competitive/Market Scan**
   - Phases: collect signals -> compare competitors -> risks/opportunities -> executive summary.
   - Good for dashboard/process positioning.

## Files Likely To Change

- Maybe create: `src/main/process/templates.ts`
- Maybe create: `src/main/process/templates.test.ts`
- Modify: `src/main/ipc/process-handlers.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/components/process-screen.tsx`
- Maybe create: `src/renderer/src/components/process-templates.tsx` if the UI gets large
- Maybe create: `resources/process-templates/*.json` or `src/main/process/templates/*.ts` depending on packaging needs

## Step-by-Step Plan

### Task 1: Decide template storage format

**Objective:** Pick a format that is easy to test and package.

**Recommendation:** Use typed TypeScript template objects under `src/main/process/templates.ts` first. Move to JSON resources later only if non-developers need to edit templates.

**Template wrapper shape:**
- `id`
- `name`
- `description`
- `category`
- `tags`
- `difficulty`
- `estimatedPhases`
- `definition` compatible with `ProcessExport`

**Acceptance Criteria:**
- Template definitions can be listed without touching SQLite.
- Template instantiation reuses existing import/create validation.

### Task 2: Add template catalog tests

**Objective:** Ensure every built-in template is valid and importable.

**Files:**
- Create: `src/main/process/templates.test.ts`

**Test cases:**
1. Every template has unique `id`.
2. Every template has non-empty name/description/category.
3. Every template imports through `importProcessExport` without throwing.
4. Re-importing the same template creates a second independent process definition.

**Command:**
```bash
pnpm vitest run src/main/process/templates.test.ts
```

### Task 3: Implement initial template catalog

**Objective:** Add 3-5 genuinely useful starter process definitions.

**Files:**
- Create: `src/main/process/templates.ts`

**Implementation notes:**
- Avoid hardcoded local account IDs.
- Runtime configs should default to inherit unless a slot recommendation is non-binding metadata.
- Include clear phase names and descriptions.
- Include completion contracts where useful.
- Use validators sparingly so templates do not feel heavy by default.

**Acceptance Criteria:**
- Catalog exports typed `listProcessTemplates()` and `getProcessTemplate(id)` helpers.

### Task 4: Add IPC/preload APIs

**Objective:** Expose template listing and instantiation to renderer.

**Files:**
- Modify: `src/main/ipc/process-handlers.ts`
- Modify: `src/preload/index.ts`

**Possible API:**
- `window.cowork.process.listTemplates()`
- `window.cowork.process.createFromTemplate(templateId, options?)`

**Acceptance Criteria:**
- Template creation returns the new process ID.
- Invalid template IDs return a user-safe error.

### Task 5: Add template browser UI

**Objective:** Make templates discoverable in Processes.

**Files:**
- Modify: `src/renderer/src/components/process-screen.tsx`
- Maybe create: `src/renderer/src/components/process-templates.tsx`

**UI behavior:**
1. Add `New from template` near existing create/import controls.
2. Show cards with name, description, tags, phase count, and recommended use.
3. Let user preview phases before creating.
4. On create, select/open the new process in Builder.

**Acceptance Criteria:**
- A new user can create a working process from a template in under 30 seconds.

### Task 6: Runtime guidance and account independence

**Objective:** Templates should work across user setups.

**Implementation notes:**
- Do not include account IDs in built-in templates.
- Use inherited runtime by default.
- Add optional template metadata like `recommendedRuntimeSlots` for UX hints, not execution requirements.
- If import account remapping exists by then, integrate it for templates that include optional runtime recommendations.

### Task 7: Manual validation

**Objective:** Validate onboarding value.

**Steps:**
1. Run `pnpm dev`.
2. Open Processes.
3. Create a process from each built-in template.
4. Confirm the created process is editable.
5. Run at least one template end-to-end.
6. Export and re-import a template-created process.

## Tests / Validation

Run:
```bash
pnpm vitest run src/main/process/templates.test.ts
pnpm vitest run src/main/process/io.test.ts
pnpm vitest run src/renderer/src/components/process-screen.test.tsx
pnpm run typecheck
pnpm run test
pnpm run build
```

## Risks / Tradeoffs

- Bad templates can make Processes feel more confusing than blank-state creation; keep the first set small and polished.
- Templates should not depend on paid/provider-specific models.
- If templates are stored in source as TS objects, non-dev editing is harder; acceptable initially for stronger type safety.

## Open Questions

- Should templates be bundled only, user-editable, or both?
- Should templates include recommended models as hints once account remapping exists?
- Should the template browser become the default empty state for Processes?
