# PR27: Agent management UI — create, edit, and delete agents in-app

> Status: **NOT STARTED**. Complements `025`/`026` (Process phases bind agents **by name**, so those
> agents must exist and be authorable). Follows the **skills editor** pattern (`skills-screen.tsx`,
> `skills:read`/`skills:write` with the `assertSkillPath` guard) applied to the file-based **agents**
> subsystem (`src/main/agent/agents/`). Builds on the custom-agents PR that added agent discovery +
> the picker.

## Context

Agents are file-based `<name>.agent.md` (YAML frontmatter + markdown body) discovered from disk
(`src/main/agent/agents/sources.ts` → user dir `~/.cowork/agents`, custom folders, workspace dirs;
`loader.ts` parses them). An agent's shape (`src/main/agent/agents/types.ts`): `name`, `description`,
tri-state `tools[]` (friendly categories — `read, search, edit, execute, web, browser, todo, agent`
in `tool-categories.ts`), tri-state `skills[]`, `children[]`, `userInvocable`, and the markdown
`body` (the system prompt). **Agents carry no `model` field** — model is a per-conversation
selection.

Today there is **no in-app way to create, edit, or delete an agent**. `agents:list` and
`agents:sources` exist (`src/main/index.ts` ~316/348), and Settings has a read-only **folder
registration table** (`settings-screen.tsx` ~804-884) — but authoring happens by hand-editing files
on disk (or the terminal `gsd-new-agent` skill). Contrast the **skills** view
(`skills-screen.tsx`), which round-trips the raw `SKILL.md` via `skills:read`/`skills:write` behind
`assertSkillPath`. This PR gives agents the same treatment **plus create/delete**, so a user can
author the agents that `025`/`026` phases assign.

## Goal

1. **Read/edit** an existing agent file from the app — name, description, body (system prompt),
   tri-state **tools** (the 8 categories), tri-state **skills** (from the skill catalog),
   `children`, `userInvocable`.
2. **Create** a new agent (scaffold a valid `<name>.agent.md` into a writable source dir) and
   **delete** one (writable sources only; never a read-only/bundled seed).
3. A picker-friendly surface so `026`'s per-phase agent pool can reference real, authored agents.

## Likely shape (hypothesis — revisit per Open questions)

### A. IPC (mirror the skills channels, in `src/main/index.ts` + preload)
- `agents:read(path)` → raw file; `agents:write(path, contents)` → save; `agents:create({dir, name})`
  → scaffold + return path; `agents:delete(path)`. All guarded by an **`assertAgentPath`** (basename
  `*.agent.md`, resolves inside a known agent source root via an `allAgentRoots()` helper — the exact
  analog of `assertSkillPath`/`allSkillRoots`). Writes go through the existing frontmatter
  parser/serializer (`agents/loader.ts`) so tri-state semantics are preserved.

### B. Surface
- Either a dedicated **`agents-screen.tsx`** (mirroring `skills-screen.tsx` — a left tree of agent
  sources, a View/Edit toggle) or a **Capabilities-tab section** in `settings-screen.tsx` next to the
  existing folder table. Lean a **dedicated screen** for parity with Skills and room for structured
  editors (tool/skill pickers) rather than raw text.
- **Structured editors** for the tri-state fields: a tools picker over the 8 categories and a skills
  picker over `skills:catalog`, each expressing all / none / specific. Body stays a markdown editor.

## Open questions to resolve BEFORE building
1. **Dedicated screen vs Settings section.** Lean **dedicated `agents-screen.tsx`** (Skills parity).
2. **Tri-state UX.** How the tool/skill pickers express `undefined` (all) vs `[]` (none/floor) vs a
   specific list without confusing the user. Lean an explicit tri-state control (All / None /
   Choose…).
3. **Which dir a new agent lands in.** The user dir by default vs a chosen custom folder. Lean
   **user dir**, with a source dropdown when custom folders are registered.
4. **Delete protection.** Never delete bundled/read-only seeds; confirm before deleting. Mirror
   whatever `028` chooses for skills.
5. **Model per agent.** Keep `model` off agents (per-conversation today) or add it now for `025`
   per-phase model pinning? Lean **keep off**; revisit only if `025` Q8 needs it.

## Verification (when built)
- **Unit:** `assertAgentPath` accepts a valid path under a source root and rejects traversal/foreign
  paths; create scaffolds a parseable agent; write round-trips tri-state fields (undefined vs [] vs
  list) through the loader; delete removes only within writable roots.
- **Manual (real app):** create an agent, assign specific tools + skills, save; it appears in the
  composer picker and in `026`'s per-phase agent pool; edit it and see changes take effect on the
  next turn; delete it.
- `pnpm typecheck` + `pnpm build` clean; verified in the running app.

## Out of scope
- **The Process engine/UI** — `025`/`026` (this PR only authors the agents they reference).
- **Skill authoring** — `028`.
- **Agent versioning / sharing / import-export** — later.
- **A per-agent model field** unless `025` requires it.
