# Single-file mutation and one-shot command cleanup failures are suppressed

> Status: **Fixed**
> Severity: **P2 — silent temporary-file and source leakage**
> Area: mutation cleanup and local command staging

## Problem

Single-file atomic mutation ignores failure while deleting its staged temporary
file. If the commit succeeded, the caller receives plain success even though a
workspace artifact remains; if the commit failed, the cleanup failure is lost.

The local one-shot command path likewise suppresses failure while removing a
temporary source/heredoc file, which can leave command text or secrets on disk.
Multi-file patching already reports cleanup failure with committed state, so the
tool surface currently has inconsistent integrity semantics.

## Reproduction test

Inject cleanup failures after successful and failed single-file commits and after
one-shot command execution. Assert the result distinguishes primary failure,
cleanup failure, and whether the intended mutation or command already committed.

## Fix direction

Adopt the multi-file patch cleanup contract across single-file mutation and
command staging. Return structured cleanup diagnostics with `committed` or
execution status, and retain enough path information for safe remediation
without exposing sensitive contents.

## Acceptance criteria

- Cleanup failures are never silently converted to success.
- Results distinguish committed success plus cleanup failure from an uncommitted
  primary failure.
- Command-source leaks are reported without echoing secrets.
- Normal cleanup remains idempotent and existing error causes are preserved.

## Resolution

Single-file atomic writes now use the same cleanup diagnostic contract as
multi-file patches. Successful writes/edits that retain staged files or backups
return `ERROR[cleanup_failed]` with `committed: true` semantics at the helper
boundary, while failed writes preserve the primary `commit_failed`, stale, or
file-size result and attach retained cleanup paths.

Local command heredoc staging now reports temporary-source cleanup failures on
both quick `run_shell_tool` compatibility output and structured command-session
results. Diagnostics include the retained temp path and cleanup error, but not
the materialized script contents.
