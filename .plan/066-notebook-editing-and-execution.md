# PR66: Notebook editing and cell execution

> Status: **DEFERRED**. Depends on `063` for safe notebook reading and on a reviewed
> kernel/runtime contract. Reading a notebook never implies executing it.

## Goal

Add explicit tools:

- `read_notebook(path, cursor?)` (backed by `063`)
- `edit_notebook_cell(path, cell_id/index, source, expected_revision)`
- `insert_notebook_cell` / `delete_notebook_cell`
- `run_notebook_cell(path, cell_id/index, kernel?, timeout?)`

## Design and safety

- Preserve notebook metadata and unknown fields; edits use revision checks and atomic
  writes, never text replacement against raw JSON.
- Cell identity prefers stable `id`; index is accepted only with a matching notebook
  revision.
- Execution uses the selected North Star Environment and a configured kernel/runtime;
  never silently uses a host Python or installs packages.
- Running a cell is arbitrary code execution and uses execution approval, Stop,
  timeout, output caps, and durable session cleanup.
- Outputs are typed/capped; rich binary outputs become attachments/artifacts rather
  than giant base64 tool strings.
- `edit_notebook` and `execute_notebook` are separate capabilities for external-agent
  fidelity.

## Verification

- Markdown/code/raw cells, stable IDs, metadata preservation, concurrent revision
  conflicts, malformed notebooks, large/rich outputs, errors, interrupts, and
  Local/container kernels.
- Reading/editing cannot execute cells; executing cannot escape Environment policy.

## Out of scope

- Installing kernels, live Jupyter server UI, whole-notebook execution in v1, or
  silently trusting notebook metadata/extensions.

