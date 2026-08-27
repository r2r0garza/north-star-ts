# list_files can enumerate directories outside the Local workspace

> Status: **FIXED**  
> Severity: **P1 — workspace confidentiality boundary bypass**  
> Area: directory listing

## Problem

`list_files_tool` resolves its path with `resolveLexical` and immediately calls
`readdir`. A symlink located inside the workspace and pointing to an external
host directory therefore exposes that directory's names to the model.

## Reproduction test

Create a workspace symlink to an external temporary directory containing a
sentinel file. Call `list_files_tool` on the symlink and assert the call is
rejected without revealing the sentinel name.

## Fix direction

Resolve opened directories through `await env.resolve(path)`. Keep the lexical
resolver only for operations that do not dereference the result.

## Acceptance criteria

- Local external-directory symlinks are rejected.
- Ordinary in-workspace directories and in-workspace symlinks still list.
- Container behavior is covered separately by brief 027.
