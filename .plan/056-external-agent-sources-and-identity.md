# PR56: External agent sources, parsers, and source-qualified identity

> Status: **DONE**. Implemented by `243e4bf` with source-qualified discovery,
> provider-specific parsing, compatibility diagnostics, read-only external rows, and
> UI/IPC support for qualified agent identity.

## Context

North Star currently treats every discovered agent as if it used North Star's own
`<name>.agent.md` schema. `src/main/agent/agents/loader.ts` parses one frontmatter
shape, `loadAgents` deduplicates by bare `name` with last-wins semantics, conversations
and Process phase pools persist only `agentName`, and `.github/agents` is fed through
that native parser.

That is no longer sufficient. Cursor, GitHub Copilot, Claude Code, and Codex agents
have different file formats, defaults, identity rules, and metadata. Two valid agents
can also share the same native name. A workspace may legitimately contain all of:

- `north star: reviewer`
- `github: reviewer`
- `cursor: reviewer`
- `claude: reviewer`
- `codex: reviewer`

Collapsing those to `reviewer` silently selects the wrong definition and makes it
impossible for later plans to enforce the source agent's actual permissions.

External definitions are **view-only** in North Star. North Star must not normalize,
rewrite, rename, or delete another system's files, and unknown source fields must be
preserved in the parsed representation for diagnostics/future support.

## Goal

1. Discover global and workspace agents from all agreed source locations.
2. Parse each source with its own adapter and source-specific defaults/tolerance.
3. Give every definition a stable, source-qualified reference rather than relying on
   a globally unique bare name.
4. Show origin-qualified labels in every picker and retain all same-name definitions.
5. Migrate conversation and Process references so the selected definition can be
   resolved deterministically on later turns and after app restart.
6. Surface parse/compatibility diagnostics without making one bad file hide healthy
   siblings.

## Source matrix

| Source kind | Global sources | Workspace sources | Native format | Direct picker default | Writable in North Star |
| --- | --- | --- | --- | --- | --- |
| `north_star` | `~/.<system>/agents`, registered custom folders | `<workspace>/.<system>/agents` | North Star `.agent.md` YAML + Markdown | `user-invocable` | Existing user/custom rules only |
| `github` | `~/.copilot/agents` | `<workspace>/.github/agents`, `<workspace>/.copilot/agents` | Copilot agent Markdown/YAML | Respect `user-invocable` (source default applies) | No |
| `cursor` | `~/.cursor/agents` | `<workspace>/.cursor/agents` | Cursor agent Markdown/YAML | Yes | No |
| `claude` | `~/.claude/agents` | `<workspace>/.claude/agents` | Claude agent Markdown/YAML | Yes | No |
| `codex` | `~/.codex/config.toml`, `~/.codex/agents` | `<workspace>/.codex/config.toml`, `<workspace>/.codex/agents` | `[agents.<name>]` registry + referenced/standalone TOML agent config | Yes | No |

Compatibility paths exposed by another product must not cause the same physical file
to appear twice. Canonicalize real paths where safe, deduplicate identical definition
files by canonical path, and retain the parser/source with the highest native
precedence. Symlink escapes must not turn discovery into an out-of-scope filesystem
read.

## Normalized definition and identity

Replace the assumption that `AgentDefinition` is also the on-disk schema with two
layers:

```ts
type AgentSourceKind =
  | "north_star"
  | "github"
  | "cursor"
  | "claude"
  | "codex"

interface AgentRef {
  sourceKind: AgentSourceKind
  scope: "global" | "workspace" | "custom"
  definitionPath: string
  nativeName: string
}

interface ParsedAgentDefinition {
  ref: AgentRef
  name: string
  description: string
  body: string
  userInvocable: boolean
  sourceMetadata: unknown
  diagnostics: AgentCompatibilityDiagnostic[]
}
```

The stored reference should be an opaque, versioned serialization of `AgentRef`, not
a UI label and not a hash that cannot be diagnosed. `definitionPath` is canonicalized
and may be stored workspace-relative when the file is under the workspace so moving a
project does not unnecessarily orphan every selection. Global paths remain explicit.

The visible primary label is `<source label>: <native name>`. Scope/path is secondary
text when two entries would still render identically (for example the same GitHub name
in `.github/agents` and `.copilot/agents`). Do not encode presentation text into the
database reference.

## Parser behavior

### North Star

- Keep the existing strict authoring schema and tri-state fields.
- Preserve existing create/edit/delete/import behavior for writable North Star roots.
- Stop using this parser for GitHub/Copilot files.

### GitHub Copilot

- Accept `.md` agent profiles, including `.agent.md`.
- Require `description`; tolerate omitted `name` and derive a display/native name from
  the filename according to Copilot's documented behavior.
- Parse `argument-hint`, `tools`, `user-invocable`, `model`, `target`, `mcp-servers`,
  `disable-model-invocation`/`infer`, and `deferred-tool-loading` without discarding
  unknown fields.
- Respect the source default for `user-invocable` when omitted; do not reuse North
  Star's current default-false behavior.
- `target` affects compatibility diagnostics, not discovery: an agent that excludes
  North Star's equivalent environment remains visible but may be incompatible.

### Cursor

- Accept `.cursor/agents/*.md`; do not require the North Star `.agent.md` suffix or
  name===stem rule.
- Parse `name`, `description`, `model`, `readonly`, and `is_background` using Cursor's
  source defaults. Be tolerant of valid files whose current Cursor surface omits a
  model and treat omitted model as inherit for North Star execution.
- Project definitions retain Cursor's documented precedence over user definitions,
  but source-qualified identity prevents unrelated providers from overriding them.

### Claude Code

- Accept `.claude/agents/*.md` with Claude's YAML frontmatter and Markdown prompt.
- Parse `name`, `description`, `tools`, `disallowedTools`, `model`, `permissionMode`,
  `maxTurns`, `mcpServers`, `hooks`, `memory`, `background`, `effort`, `isolation`,
  `color`, `initialPrompt`, and `skills`.
- Preserve raw parameterized tool rules such as `Skill(name *)` and
  `Agent(test-writer, code-reviewer)` for `057`; do not flatten them into North Star's
  current category list during parsing.

### Codex

- Parse global/workspace `config.toml` `[agents.<name>]` registry entries and resolve
  `config_file` relative to the declaring config when it is not absolute.
- Scan the corresponding `agents` directory for supported standalone TOML agent
  configs so explicitly requested directory discovery does not depend on registration.
- Parse current supported fields including `name`, `description`,
  `developer_instructions`, `model`, `model_reasoning_effort`, and `sandbox_mode`;
  preserve unknown keys and report them rather than rejecting the whole definition.
- A registered entry is authoritative for its name/description/config target. Avoid a
  duplicate when the directory scan reaches the same referenced config.
- Codex's schema is version-sensitive. Keep parsing isolated and tolerant so adding a
  field does not require changing the shared agent model.

## Persistence migration

Bare names are currently stored in:

- `conversations.agent_name`
- Process phase pools / validator agent references
- phase-run history and task input snapshots used for diagnostics/resume

Add source-qualified reference columns/fields while retaining the human-readable
native name for history. New selections write the opaque `agentRef`. Resolution uses
the ref first and never silently substitutes a same-name definition from another
source.

Legacy bare-name rows require a deterministic compatibility migration:

1. Resolve against the old source order once.
2. Persist the resulting source-qualified ref when exactly one old-style match wins.
3. If no definition exists, preserve the name as missing.
4. If the old semantics are ambiguous, preserve the previous last-wins result and add
   a migration/compatibility diagnostic; never choose a different source merely
   because the new UI sorts differently.

A deleted/moved definition leaves a visible "Missing agent" reference. Conversations
fall back to no custom agent only after informing the user; Process routing skips a
missing pool member and records the reason, failing clearly if no runnable member
remains.

## UI and IPC

- `agents:list` returns `{ref, sourceKind, scope, name, description, label,
  diagnostics}` rather than `{name, description}`.
- The composer and Process pickers store/refetch `ref`, render the qualified label,
  and use path/scope as secondary disambiguation.
- The Agents screen groups external folders by provider and scope, displays their
  parsed metadata and raw compatibility warnings, and marks all external rows
  read-only.
- Native North Star create/import/edit/delete affordances remain available only on
  their existing writable roots.
- One malformed file produces a row-level/source diagnostic and never aborts the
  catalog.

## Verification

- Parser fixture suites for every provider, required/optional fields, defaults,
  unknown fields, malformed YAML/TOML, and non-native filename rules.
- Global+workspace precedence tests within each provider.
- Same-name agents from all five sources remain independently selectable and resolve
  back to the exact file/config after restart.
- `.github/agents` and `.copilot/agents` use the GitHub parser, never the North Star
  parser.
- Registered and directory-scanned Codex configs do not duplicate.
- External files are not offered to save/delete/import-overwrite IPC paths.
- Legacy conversation and Process name references retain their previous effective
  selection or become an explicit missing reference.
- `pnpm typecheck`, targeted main/renderer tests, DB migration tests, and packaged-app
  discovery smoke tests on macOS/Windows/Linux.

## Out of scope

- Enforcing tool/skill/child/MCP capability semantics (`057`).
- Resolving or overriding external model/background/isolation/runtime metadata
  (`058`).
- Passing an agent to `claude --agent` or selecting a Codex CLI agent. The agent picker
  remains hidden for Claude Code and Codex CLI conversations; native CLI-agent support
  needs its own future design.
- Editing or importing changes back into external agent formats.
