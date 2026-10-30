# Workflow JSON Export and Import — Requirements and Implementation Plan

## Scope and source objective

Implement export and import of saved Workflows as JSON files. Existing workflows are persisted in the main-process SQLite repository and edited from the Workflows collection/editor. This plan covers workflow definitions, not workflow-run history or conversations.

## Requirements and testable acceptance criteria

### Explicit requirements

- Users can export workflows as `.json` files.
- Users can import workflows from `.json` files.
- Preserve the existing workflow editing and persistence model; do not change workflow execution/run behavior.

### Acceptance criteria

1. From the workflow collection, a user can export a saved workflow as a portable definition: `id`, `name`, `description`, `defaultObjective`, optional `viewInConversationSidebar`, and ordered `steps` with each step’s `id`, `title`, and `instructions`. Exported steps omit `accountId`, `modelId`, and `agentName` entirely, including null selections. Saved local model/account/agent settings remain unchanged.
2. A user can import a valid workflow JSON file and it appears in the collection, is persisted, and can be edited/run using existing functionality. IDs must be unique relative to already stored workflows; imported data must not overwrite an existing workflow.
3. Imported JSON is validated before assigning fresh copy IDs or accessing persistence using the same schema rules as workflow updates (required string fields, optional boolean flag, steps array, valid step fields, nonempty unique step IDs). Invalid or unreadable files produce a visible error and do not partially change saved workflows. Portable files without model/account/agent selections are accepted; older valid files containing these optional fields remain supported.
4. Canceling the native file picker is a no-op. The import picker filters for JSON, and export uses a save dialog with a `.json` filename/extension.
5. Export/import errors are surfaced in the UI without losing or altering workflows. Successful operations update/reload the collection to reflect persisted state.

## Existing functionality and integration points

- `src/shared/workflows.ts`: canonical `WorkflowDefinition` and `WorkflowStep` types.
- `src/main/db/repositories/workflows.ts`: `listWorkflows`, `createWorkflow`, `updateWorkflow`, and validation. Import should reuse the canonical update validation or extract a narrowly scoped validator if needed; avoid duplicating schema checks.
- `src/main/ipc/db-handlers.ts`: workflow IPC handlers, including create/list/update and synchronous flush.
- `src/preload/index.ts`: typed `window.cowork.db.workflows` bridge. Renderer must access main-process capabilities through this API.
- `src/main/pick-workspace.ts`: existing Electron native open-file picker conventions and cancellation result; extend or add workflow JSON picker/save-dialog helpers in the same pattern.
- `src/renderer/src/components/workflows-screen.tsx`: workflow collection header/actions and state/error toasts; appropriate place for Import and per-workflow Export controls.
- `src/renderer/src/components/workflow-detail.tsx`: editor for a single definition; likely unnecessary to modify unless product interaction requires export there.
- Tests: `src/main/db/repositories/workflows.test.ts`, `src/main/ipc/subscription-handlers.test.ts` or IPC-related tests, preload tests, and `src/renderer/src/components/workflows-screen.test.tsx` cover repository, bridge/handler, and collection UI patterns.

## Simplest implementation approach

Use Electron’s main process for all native file dialogs and filesystem access. Add typed preload methods and narrow IPC endpoints for export and import. Export serializes a portable copy of the selected saved definition as formatted JSON, omitting per-step `accountId`, `modelId`, and `agentName`, and writes only to the path chosen by `showSaveDialog`. It never mutates the saved definition. Import reads the path returned by an open dialog, parses JSON, validates it against the workflow definition rules, assigns a fresh UUID to the imported workflow (and fresh IDs to each step if needed to prevent collision/maintain unique-step validation), then saves through the existing repository. Return the created definition to the renderer so the collection can append/select it. Keep cancellation distinct from errors. Do not put arbitrary renderer-provided filesystem paths into a privileged read/write endpoint: have the main process own picker and file operations.

## Ordered implementation tasks

1. Confirm existing Electron dialog and filesystem error-handling conventions and determine whether export should be available per workflow card or in the editor; default to per-card Export and collection-level Import for consistency with workflow selection.
2. Add import/export operations in a small main-process workflow service/module. Reuse the existing definition type and repository validation. Validate the JSON object strictly before inserting; do not accept run data or unknown malformed step fields as a definition.
3. Add native JSON open/save dialogs, with cancellation handling and suggested export filename derived safely from the workflow name; ensure a `.json` extension.
4. Register IPC endpoints in `src/main/ipc/db-handlers.ts` and expose typed methods in `src/preload/index.ts`; keep filesystem paths private to main.
5. Add collection UI controls and loading/error/success handling in `workflows-screen.tsx`. Refresh local workflow state after a successful import, and ensure an export does not mutate current state.
6. Add focused tests for validation/import persistence/unique IDs, cancellation and file I/O errors, IPC/preload contract, and UI success/error states.
7. Run focused relevant tests and typecheck/lint as applicable; do not run the full test suite during this implementation step unless later workflow instructions explicitly require it.

## Potential regressions and dependencies

- Export must include recently edited unsaved text if invoked from an open editor; if export is card-only, existing editor saves on blur/leave and this behavior should remain explicit. Avoid racing queued editor persistence.
- Database IDs and step IDs are internal identifiers. Reusing imported IDs can collide with existing rows/step expectations, so imports should receive new IDs; preserve step order and content.
- Preserve `defaultObjective` and `viewInConversationSidebar` when present; older/minimal definitions may omit optional fields, which the existing type/repository supports.
- Malformed JSON, valid JSON with invalid shape, inaccessible files, unwritable destinations, and dialog cancellation need distinct safe outcomes; no partial insert/write.
- Avoid importing execution run snapshots or model credentials/secrets; a workflow definition contains only the fields in the shared type.
- IPC signatures must remain typed consistently across main, preload, and renderer tests.

## Verification mapped to acceptance criteria

- AC1: unit test exact serialized portable contents and step ordering, omission of model/account/agent keys for populated and null selections, and unchanged saved source settings; manually inspect save-dialog file output if feasible.
- AC2: repository/service test imports a definition with existing IDs, verifies new workflow and step IDs, persistence after reload, and unchanged prior records.
- AC3: focused import tests reject malformed JSON, non-object data, missing/wrong required fields, malformed steps, and duplicate step IDs; assert saved list is unchanged. Native-independent tests cover missing, empty, and duplicate step IDs and numeric workflow IDs, asserting no database access or insertion. Verify portable exports import without overrides and legacy valid optional selections remain accepted. UI test verifies error toast/message.
- AC4: dialog helper tests or IPC mocks verify JSON filters, `.json` save path/default name, and canceled picker returns without database or file operation.
- AC5: component tests verify successful import updates collection, export errors are surfaced, and export leaves workflow state unchanged. Run focused tests and relevant typecheck after implementation.

## Assumptions and unresolved ambiguities

- “Workflows” means reusable `WorkflowDefinition` records, not workflow runs or run history.
- Import is a copy operation, not a replacement/upsert: assign fresh workflow and step IDs to avoid collisions; all user-authored text and configuration are preserved.
- JSON should be human-readable/pretty-printed and use UTF-8. No versioned wrapper is proposed because the current schema has no version field; export the definition object directly.
- The objective does not specify bulk import/export, drag-and-drop, backup/restore, conflict resolution, or whether export belongs in the editor. Assume one workflow per file, import one file per action, export from collection card, and record any UI adjustment if existing patterns favor otherwise.
