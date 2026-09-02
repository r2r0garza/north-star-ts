---
status: IMPLEMENTED
severity: P2
trigger: "Files referenced beside SKILL.md are resolved against the conversation workspace instead of the activated skill directory"
created: 2026-08-31
updated: 2026-08-31
---

## Symptoms

- Expected: after a skill is activated, relative paths in its instructions resolve
  from the skill root (the directory containing `SKILL.md`).
- Actual: `read_skill` returns only the Markdown body, so the model is not given a
  usable skill root for paths such as `references/template.html` or
  `References/Logo.png`.
- Actual: ordinary file tools resolve those paths against the conversation
  workspace. Global and custom skills commonly live outside that workspace, so
  their bundled resources cannot be read.
- Example: a dashboard skill says to use `references/template.html`, but the
  agent either fails to find it or invents a replacement because it searches the
  CWD.
- Example: a slide-deck skill says to read `References/Logo.png`; the resource is
  beside `SKILL.md`, but the agent cannot use it as input to whatever operation
  the skill requests.

## Original investigation (before implementation)

- hypothesis: skill discovery retains the absolute `SKILL.md` path, but skill
  activation discards that location and exposes only the body. The tool
  environment has only a writable workspace root and no read-only auxiliary root
  for an activated skill, so later relative paths necessarily fall back to the
  CWD or fail confinement.
- test: activate global, custom, and project skills containing text, image, and
  script resources, then use existing agent tools to consume those resources
  while preserving workspace-only writes.
- expecting: every bundled path resolves from its owning skill directory;
  resources are available as general read-only inputs; the agent, rather than
  skill-specific app code, decides whether to read, encode, inspect, execute, or
  otherwise process them.
- planned_action: design the read-only skill-root abstraction and its local/container
  path semantics before changing individual file tools.
- reasoning_checkpoint: this is not a missing base64, image-copy, HTML-template,
  or other resource-specific feature. It is a missing filesystem capability for
  the full skill directory.

## Implementation

- timestamp: 2026-08-31
  observation: `read_skill` now registers the selected skill directory in the
  turn context, returns a `skill://<skill-name>/` root hint, and includes a
  bounded bundled-resource manifest without eagerly reading resource contents.
- timestamp: 2026-08-31
  observation: slash-selected skills are now passed as structured chat request
  data, registered before the first model call, and surfaced in a lightweight
  "User-selected skills" prompt section with their active `skill://` roots.
- timestamp: 2026-08-31
  observation: `read_file_tool`, `read_document`, `list_files_tool`,
  `search_tool`, and `stat_path` can consume activated `skill://` resources as
  read-only inputs.
- timestamp: 2026-08-31
  observation: `write_file_tool`, `edit_file_tool`, `apply_patch_tool`,
  `create_directory`, `move_path`, and `delete_path` reject `skill://` targets
  explicitly.
- timestamp: 2026-08-31
  observation: the skill resource resolver rejects inactive skill roots,
  absolute paths, parent traversal, NUL bytes, wrong path casing, and symlinks.

## Remaining Boundary

- timestamp: 2026-08-31
  observation: shell command text is not rewritten to substitute `skill://`
  paths. Bundled scripts are discoverable and readable/stat-able through the
  same skill-root abstraction, but direct execution remains a separate command
  feature because arbitrary shell-string rewriting would expand the mutation and
  approval surface.

## Original evidence (before implementation)

- timestamp: 2026-08-31
  observation: `SkillMetadata.path` stores the absolute path to `SKILL.md` in
  `src/main/agent/skills/loader.ts`.
- timestamp: 2026-08-31
  observation: `createReadSkillTool` returns only `skill.body` from
  `src/main/agent/skills/tool.ts`; it does not disclose or register the skill
  directory.
- timestamp: 2026-08-31
  observation: `read_file_tool` resolves workspace-session paths exclusively
  through the workspace environment and limits Chat reads to attachments.
- timestamp: 2026-08-31
  observation: workspace path resolution rejects absolute and parent-traversal
  paths outside the workspace, so merely including the host skill path in the
  prompt would not make resources usable by existing tools.
- timestamp: 2026-08-31
  observation: ZIP skill import preserves supporting files, while standalone
  Markdown import copies only `SKILL.md` and therefore cannot preserve adjacent
  resources.

## Proposed Direction

Treat each activated skill directory as a general-purpose, read-only auxiliary
filesystem root:

1. Have `read_skill` return structured identifying context for the activated
   skill, including a stable skill-root identity and a bounded manifest of its
   bundled files. Do not eagerly load every resource.
2. Extend the tool environment with read-only skill roots. Existing read,
   document, image, and command capabilities should be able to consume a skill
   resource as input without granting write access to the skill directory.
3. Use an unambiguous portable namespace, such as
   `skill://<skill-name>/<relative-path>`, and resolve it to a stable local or
   container-visible path when a tool requires a real filesystem path.
4. Keep all output mutations confined to the active workspace. Skill roots are
   inputs only.
5. Resolve a resource through the exact skill selected after source precedence
   and agent capability filtering; never search other same-named skill folders.

The resource layer must remain operation-agnostic. For example, if a skill asks
the agent to base64-encode a PNG into an HTML file, the app exposes the PNG as a
read-only input and the agent performs the encoding with its available tools.
The app must not implement special behavior for logos, base64, HTML, dashboards,
or slide decks.

## Security Requirements

- Reject absolute resource paths, parent traversal, NUL bytes, and unknown skill
  names at the skill namespace boundary.
- Resolve real paths and reject symlinks whose targets leave the selected skill
  root.
- Keep skill roots read-only even when the workspace is writable.
- Preserve command approval requirements, especially for executable scripts.
- Bound manifest traversal, entry count, individual resource reads, and rendered
  tool output.
- Ensure container-backed runs receive only the activated/allowed skill roots,
  mounted or staged read-only.
- Do not treat arbitrary custom-skill parent directories as readable; expose only
  the selected skill folder.

## Acceptance Criteria

- A project skill can read a referenced text template beside its `SKILL.md`.
- A global or registered custom skill outside the workspace can do the same.
- An agent can use a bundled binary resource as input to a general operation
  requested by the skill without resource-specific application code.
- Bundled scripts are addressable through the same skill-root abstraction and
  retain the normal execution approval boundary.
- Writes, edits, renames, and deletions targeting a skill root are rejected.
- `..`, absolute-path, sibling-prefix, and symlink escape attempts are rejected.
- Activating two skills does not make a plain relative path ambiguous; the path
  carries its owning skill identity.
- Source precedence selects resources from the same skill instance whose
  instructions were activated.
- Local and container environments behave consistently.
- Importing a standalone `SKILL.md` that references adjacent files warns that
  those resources are not included; ZIP/folder import preserves them.
- Regression tests cover exact path casing, including `references/` versus
  `References/`, for case-sensitive environments.

## Eliminated

- hypothesis: the affected skills need more explicit prose telling the agent to
  inspect their reference folders.
  reason: the model cannot access the correct directory even when the relative
  path is explicit.
- hypothesis: add a dedicated base64 or logo-copy feature.
  reason: that fixes one example rather than making arbitrary bundled skill
  resources available to the agent.
- hypothesis: allow unrestricted absolute paths in workspace tools.
  reason: that would weaken filesystem confinement far beyond the selected skill
  directory.
