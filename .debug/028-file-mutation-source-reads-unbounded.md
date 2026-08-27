# File mutation tools read complete source files without a size bound

> Status: **RESOLVED**  
> Severity: **P2 — main-process memory exhaustion**  
> Area: edit, write, and patch planning

## Problem

`edit_file_tool`, overwrite/append in `write_file_tool`, and patch `readSource`
load the entire existing file before enforcing any result-size limit. Patch can
load several files first. Container reads additionally base64-expand and copy the
same data.

## Reproduction test

Use oversized and newline-free files on fake, Local, and Container backends.
Assert rejection occurs from stat metadata before `readFile`, including multi-file
patches whose aggregate source size exceeds the budget.

## Fix direction

Define per-file and transaction source-byte limits, preflight with `stat`, and
return a structured `file_too_large` error. If large-file mutations are required,
design streaming algorithms rather than lifting the cap.

## Acceptance criteria

- Bounded mutations never call unbounded `readFile` on oversized sources.
- Patch enforces both per-file and aggregate source budgets.
- Errors explain the supported alternative without modifying the workspace.

## Resolution

- Added shared mutation source limits and a structured `file_too_large` error.
- `edit_file_tool` and overwrite/append paths in `write_file_tool` now reject
  oversized existing files from `stat.size` before reading content.
- Patch planning preflights every existing source with `stat` and enforces both
  per-file and aggregate source-byte limits before any source `readFile`.
- Commit-time revision checks also use guarded reads so concurrent oversized
  sources are rejected rather than loaded.

## Verification

- `pnpm exec vitest run src/main/agent/tools/edit_file_tool.test.ts src/main/agent/tools/write_file_tool.test.ts src/main/agent/tools/apply_patch_tool.test.ts`
- `pnpm exec vitest run src/main/agent/tools/file_mode_mutation.test.ts src/main/agent/env/local.test.ts src/main/agent/env/container.test.ts src/main/agent/tools/edit_file_tool.test.ts src/main/agent/tools/write_file_tool.test.ts src/main/agent/tools/apply_patch_tool.test.ts`
- `pnpm exec tsc --noEmit`
