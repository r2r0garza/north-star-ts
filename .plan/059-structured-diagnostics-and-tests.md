# PR59: Structured workspace diagnostics and test execution

> Status: **NOT STARTED**. Highest-value tool addition: give agents typed
> diagnostics and test results without granting an arbitrary shell command surface.

## Context

North Star can run any project command through `exec_command`, but the model must know
the command, parse terminal prose, and retain unrestricted execution authority. GitHub
agents also distinguish `runTests`, `problems`, task output, and test failures from a
general terminal. A narrow test/diagnostic surface improves reliability and lets `057`
map those external capabilities without broadening them to all shell access.

Running a checker or test suite still executes workspace-controlled code. These tools
are structured and narrower than a shell, but they are **not read-only** and must use
the execution approval/sandbox policy.

## Goal

Add three canonical tools:

- `workspace_diagnostics` — run a configured/detected checker and return normalized
  problems.
- `run_tests` — run a configured/detected test target with bounded session support.
- `get_test_results` — page normalized results from a completed/running test session.

## Design

Define normalized records independent of runner output:

```ts
interface DiagnosticRecord {
  path?: string
  line?: number
  column?: number
  severity: "error" | "warning" | "info"
  code?: string
  message: string
  source: string
}

interface TestCaseResult {
  suite?: string
  name: string
  status: "passed" | "failed" | "skipped" | "todo"
  durationMs?: number
  path?: string
  line?: number
  message?: string
}
```

Use a provider registry (`DiagnosticProvider` / `TestProvider`) rather than one giant
parser. Initial providers should recognize project-declared scripts and common
machine-readable output already available in the workspace; provider detection is
read-only and must not run package-manager install commands. Prefer JSON/JUnit/TAP
output where a runner supports it. Keep raw bounded stdout/stderr as evidence when
normalization is partial.

`run_tests` accepts semantic inputs (`target`, optional path/name filter, timeout), not
an arbitrary command string. A workspace may explicitly register commands in Settings
when detection is insufficient; those commands are reviewed before first use and
stored separately from model input.

Reuse the command-session lifecycle for long runs, Stop, output caps, app cleanup, and
container/local execution. Associate each test session with conversation + workspace
and reject cross-conversation result reads.

## Tool and policy integration

- New friendly categories: `diagnostics` and `test` (or one `test` category if the UI
  needs fewer concepts); do not silently put them in `read`.
- Effects classify checker/test invocation as execution and route through the existing
  policy engine.
- `057` maps GitHub `read/problems`, `execute/runTests`, `vscodeGeneral/runTests`,
  `execute/testFailure`, and task-output equivalents to these tools when safe.
- Claude `LSP` diagnostics remain a `060` provider contribution; Claude Bash does not
  become necessary just to run a known test target.

## Verification

- Provider detection never mutates files or installs dependencies.
- Test/checker execution uses the selected Environment and existing cancellation,
  timeout, approval, and output-cap boundaries.
- Fixtures cover pass/fail/skip, malformed/partial output, file locations, Windows
  paths, non-zero diagnostic exits, timeouts, and cancellation.
- The agent receives normalized counts and pageable failures plus bounded raw evidence.
- An agent allowed `test` but denied `execute` can run only registered test targets and
  cannot supply an arbitrary command.
- Local/container behavior and packaged builds are verified.

## Out of scope

- Installing or choosing a project's test framework.
- Watch mode in v1.
- Semantic definitions/references (`060`).
- Automatically fixing diagnostics.

