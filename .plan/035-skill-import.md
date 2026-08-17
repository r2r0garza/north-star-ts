# PR35: Skill import — bring in a SKILL.md (or a zipped skill folder) from disk

> Status: **NOT STARTED**. Extends the Skills view (`028` shipped **create + delete** on top of the
> existing View/Edit) with **import from a file**: a single **markdown** `SKILL.md` (a bodies-only
> skill) or a **`.zip`** of a skill folder (when the skill has supporting files — scripts, references,
> assets). Writes into a **writable** source root (user + custom), reusing `028`'s guards. Complements
> the export side of `037` conceptually (processes get import+export; skills are import-only here —
> a skill folder is already on disk and shareable as a zip by hand).

## Context

Skills are file-based, discovered per-source in load order (`agent/skills/sources.ts`); a skill is a
**directory** `<source>/<name>/` containing a `SKILL.md` (YAML frontmatter `name`/`description`/optional
`allowed-tools` + a markdown body) and optionally supporting files the body references. `028` added
`skills:create` (scaffold `<dir>/<name>/SKILL.md`) and `skills:delete` (remove the folder), guarded by
`writableSkillRoots()` (**user + custom only**) + `assertSkillWritablePath`, and exported
`validateName`/`skillScaffold` from `agent/skills/loader.ts`. The Skills screen
(`skills-screen.tsx`) has a **New skill** button + hover-delete on writable rows.

The native file picker is `pickFiles()` (`pick-workspace.ts`, `dialog.showOpenDialog`) — currently
single-purpose (chat attachments, no `filters`). There is **no zip dependency** in `package.json`.

## Goal

1. **Import a `.md` file** — treat it as a `SKILL.md`: parse its frontmatter, derive/validate the skill
   **name** (frontmatter `name`, must be a valid slug), and write it as `<writable-root>/<name>/SKILL.md`.
2. **Import a `.zip`** — a skill folder archived at its root (a `SKILL.md` + supporting files); extract
   it under `<writable-root>/<name>/`, validating there's exactly one `SKILL.md` and the name resolves.
3. Both land in a chosen writable source (user default; a dropdown when custom folders exist — mirrors
   `028`'s create), reject a name collision (offer rename/overwrite per Open questions), and refresh the
   tree. The imported skill then appears in the composer menu + `027`'s agent skills picker.

## Likely shape (hypothesis — revisit per Open questions)

### A. Dependency
- Add a small, well-audited unzip lib (`adm-zip` or `yauzl` — no native build). Used **only** in the
  main process for the zip path; the `.md` path needs no dep.

### B. IPC (`skills:import`, alongside `028`'s create/delete in `index.ts`)
- A picker: extend `pickFiles` (or a dedicated `pickSkillImport`) with `filters` for `.md`/`.zip` and
  **single**-select. Then `skills:import({ sourcePath, dir })`:
  - **`.md`:** read the file, parse via the loader's `parseSkill` (reuse — validates frontmatter +
    derives `name`), reject if no valid frontmatter or bad name; write to
    `<dir>/<name>/SKILL.md`. `dir` asserted through `writableSkillRoots()` (the `028` guard).
  - **`.zip`:** extract to a **temp dir**, locate the `SKILL.md` (root, or a single top-level folder —
    normalize a `foo/SKILL.md` layout), validate name + that no path in the archive escapes
    (`../`/absolute — **zip-slip guard**), then move the folder to `<dir>/<name>/`. Size/entry-count caps.
  - Return the new SKILL.md path (renderer selects it, like `028`'s create).
- Collision handling (Open question): reject with a clear error, or import-as `<name>-2`, or prompt
  overwrite. Lean **reject + let the user rename** (safe default; matches `028`'s collision reject).

### C. Renderer (`skills-screen.tsx`)
- An **Import** button beside **New skill** (a small dropdown: "New skill" / "Import from file…"),
  opening the picker → the location dropdown (when >1 writable root) → import → refresh + select.
- Surface parse/zip errors via the existing `toast.error` pattern.

## Open questions to resolve BEFORE building
1. **Name collision.** Reject (user renames on disk / re-imports) vs auto-suffix (`-2`) vs prompt
   overwrite. Lean **reject with a clear message** (consistent with `028`'s same-dir collision reject).
2. **Zip layout tolerance.** Require `SKILL.md` at the archive root, or also accept a single wrapping
   top-level folder (`myskill/SKILL.md`) and flatten it? Lean **accept both**, reject ambiguous
   (multiple `SKILL.md`, or files at root *and* in a folder).
3. **Name source for a bare `.md`.** Always from frontmatter `name` (reject if missing/invalid) vs fall
   back to the file's basename. Lean **frontmatter `name` is authoritative** (the loader enforces
   name === dir); no silent basename guess.
4. **Unzip lib choice.** `adm-zip` (sync, simple, popular) vs `yauzl` (streaming, stricter). Lean
   **`adm-zip`** for simplicity + a manual zip-slip guard; revisit if bundle/security review objects.

## Verification (when built)
- **Unit:** importing a valid `.md` writes a parseable `SKILL.md` under a writable root and is rejected
  for a read-only/foreign root, missing frontmatter, or a bad name; a `.zip` with `SKILL.md` +
  supporting files lands the whole folder; a **zip-slip** archive (`../evil`) is rejected; a collision
  is rejected (or handled per Q1).
- **Manual (real app):** import a shared `SKILL.md`; import a zipped skill with a `scripts/` helper and
  confirm the helper file is present and the body renders; both appear in the composer menu.
- `pnpm typecheck` + `pnpm build` clean; verified in the running app.

## Out of scope
- **Export** of a skill — a skill folder is already on disk; zipping it for sharing is a later nicety
  (could pair here if cheap, but not required).
- **Create / edit / delete** — `028`.
- **Skill marketplace / remote fetch (URL / git)** — later.
- **Agent import** — `036`; **process import/export** — `037`.
