# PR28: Skill authoring — create and delete skills in the Skills view

> Status: **NOT STARTED**. Extends the existing Skills view (`skills-screen.tsx`, which already does
> View + **Edit** via `skills:read`/`skills:write` behind the `assertSkillPath` guard) with
> **create** + **delete**. Complements `027` (agent authoring) — an agent's `skills[]` can only
> reference skills that exist, so authoring skills in-app closes the loop for `025`/`026` phases.

## Context

Skills are file-based `SKILL.md` (YAML frontmatter + markdown body), discovered per-workspace in load
order (`src/main/agent/skills/sources.ts`: user dir `~/.cowork/skills` → custom folders → workspace
`.github/skills` / `.cowork/skills`; last-wins by name). Types in `src/main/agent/skills/types.ts`
(`SkillMetadata`: `name`, `description`, `path`, `body`, `source`, `allowedTools[]`, …). The Skills
view (`src/renderer/src/components/skills-screen.tsx`) loads a nested `skills:tree`, renders a
selected skill's markdown, and has a **View/Edit toggle** that round-trips the raw file via
`skills:read`/`skills:write`. Both are guarded by **`assertSkillPath`** (`src/main/index.ts` ~501:
basename must be `SKILL.md`, must resolve inside a known root from `allSkillRoots()`).

What's missing: **create** and **delete**. To add a skill today you drop a folder on disk (or it's
seeded once from bundled skills by `initUserSkills`). This PR adds a **New Skill** action and a
**delete** affordance to the Skills view, writing only into **writable** source roots.

## Goal

1. **Create** a new skill from the Skills view — scaffold a `SKILL.md` with valid frontmatter
   (`name`, `description`, optional `allowed-tools`) + a starter body — into a writable source dir.
2. **Delete** a skill (writable sources only; never a bundled/read-only seed), with confirmation.

## Likely shape (hypothesis — revisit per Open questions)

### A. IPC (add to `src/main/index.ts` + preload, alongside the existing skills channels)
- `skills:create({ dir, name, description })` → creates `<dir>/<name>/SKILL.md` from a scaffold,
  returns its path; `skills:delete(path)` → removes the skill folder. Both reuse/extend
  **`assertSkillPath`** + `allSkillRoots()` and additionally assert the target root is **writable**
  (user dir or a registered custom folder — not the bundled read-only seed dir). Create validates the
  name against the same rules the loader enforces and rejects collisions.

### B. Surface (in `skills-screen.tsx`)
- A **New Skill** button (near the tree) opening a small form (name + description + target source
  when more than one writable root exists), then dropping into the existing Edit view on the fresh
  file. A **delete** action on a selected writable skill with a confirm. Refresh the `skills:tree`
  after either.
- Scaffold template: minimal frontmatter + a `# <Name>` heading and a "when to use / steps" stub,
  matching the house `SKILL.md` shape.

## Open questions to resolve BEFORE building
1. **Target dir for a new skill.** User dir by default vs a chosen writable custom folder. Lean
   **user dir default**, with a source dropdown when custom folders are registered (mirror `027` Q3).
2. **Delete protection.** Never delete bundled/read-only seeds; guard by source kind
   (`user`/`custom` writable, `github`/`workspace`/bundled protected as appropriate) + a confirm.
3. **Name/collision rules.** Reuse the loader's name validation; reject a name that collides within
   the same source (last-wins across sources is fine, but not a same-dir dup).

## Verification (when built)
- **Unit:** `skills:create` writes a parseable `SKILL.md` under a writable root and is rejected for a
  read-only/foreign root; `skills:delete` removes only within writable roots and refuses a bundled
  seed; name validation/collision rejection.
- **Manual (real app):** create a skill from the Skills view, edit its body, save; it appears in the
  composer skill menu and is selectable in `027`'s agent skills picker; delete it and confirm it's
  gone from the tree.
- `pnpm typecheck` + `pnpm build` clean; verified in the running app.

## Out of scope
- **Editing skills** — already shipped (this PR only adds create/delete).
- **Agent authoring** — `027`.
- **The Process engine/UI** — `025`/`026`.
- **Skill sharing / import-export / marketplace** — later.
