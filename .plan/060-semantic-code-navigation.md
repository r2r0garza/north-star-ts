# PR60: Semantic code navigation tools

> Status: **NOT STARTED**. Adds precise definitions, references, symbols, hover/type
> information, and language-service diagnostics. Regex search remains available but is
> never presented as semantic analysis.

## Context

The workspace index extracts symbols and `search_tool` finds text, but neither resolves
types, imports, overloads, aliases, or true references. External agents expose concepts
such as Claude `LSP` and GitHub `vscodeGeneral/usages`; mapping them to regex search
would overstate North Star's capability.

TypeScript 5.9's Language Service exposes the needed read-only methods on one service:
definition, references, quick info, navigation trees, and syntactic/semantic
diagnostics. North Star already ships TypeScript, so TypeScript/JavaScript is the first
provider. The architecture must remain language-neutral.

## Goal

Add read-only tools:

- `workspace_symbols(query, kind?, path?)`
- `document_symbols(path)`
- `go_to_definition(path, line, column)`
- `find_references(path, line, column, include_declaration?)`
- `hover_type(path, line, column)`

Expose semantic diagnostics through `059`'s normalized diagnostic service rather than
creating a competing output shape.

## Design

Introduce a `CodeNavigationProvider` selected by workspace/file language. Results use
workspace-relative paths, one-based lines/columns, symbol kind, and bounded excerpts.
Unsupported languages return a typed `provider_unavailable` result, not a guessed regex
answer.

The TypeScript provider hosts one long-lived `LanguageService` per active workspace:

- Discover the nearest applicable `tsconfig`/`jsconfig` without evaluating project
  code.
- Implement the language-service host using workspace files and versioned snapshots.
- Invalidate snapshots on observed file revision/mtime changes; dispose services when
  the workspace closes or app exits.
- Bound project file count, file size, query results, and query duration.
- Use `getDefinitionAtPosition`, `findReferences`/`getReferencesAtPosition`,
  `getQuickInfoAtPosition`, navigation-tree APIs, and diagnostic methods directly.
- Never load editor extensions or execute language-service plugins from an untrusted
  workspace in v1.

`workspace_symbols` may use the existing index as a fast cross-language catalog, but
its output must label `precision: "indexed"`; position-based TypeScript results label
`precision: "semantic"`.

## Runtime boundaries

- All paths route through workspace resolution and remain read-only.
- The provider reads the host-visible workspace; if dependencies exist only inside a
  container, return reduced-resolution diagnostics rather than pretending full type
  resolution.
- Do not spawn an unbounded language server per tool call.
- Add a `navigation`/`lsp` tool category for external-agent mapping; do not fold it into
  generic search unless the source granted the broader group.

## Verification

- Definitions/references across imports, re-exports, aliases, overloads, JSX, and
  project references.
- Correct UTF-16 position conversion, Unicode text, one-based API coordinates, deleted
  files, and stale snapshot invalidation.
- TypeScript/JavaScript project fixtures plus unsupported-language behavior.
- No project plugin/code execution during service creation.
- Result/time/file caps prevent large workspaces from wedging Electron main.
- `057` can map Claude `LSP` and GitHub usages/codebase-search capabilities without
  granting edit or shell access.

## Future providers

Add language providers only behind the same interface after packaging/lifecycle work:
Python, Rust, Go, Java, and others. External language-server processes require their
own trust, availability, timeout, and cleanup design.

## Out of scope

- Rename, code actions, refactors, formatting, or applying compiler fixes.
- Pretending text matches are semantic references.
- Installing language servers automatically.

