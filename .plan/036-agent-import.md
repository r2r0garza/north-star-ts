# PR36: Agent import — bring in a `<name>.agent.md` file from disk

> Status: **NOT STARTED**. Extends the Agents view (`027` shipped **create + edit + delete** of the
> file-based `<name>.agent.md` agents) with **import from disk**: pick one or more `.agent.md` files
> and drop them into a **writable** agent source root (user + custom), reusing `027`'s guards +
> validation. Simpler than skill import (`035`) — an agent is a **single flat file**, no supporting
> assets, so **no zip**.

## Context

Agents are flat `<name>.agent.md` files (a suffix, not a fixed basename — unlike skills'
`<name>/SKILL.md` dirs), discovered per-source in load order (`agent/agents/sources.ts`). `027` added
`agents:create`/`save`/`delete` guarded by `assertAgentWritablePath` + `writableAgentRoots()`
(**user + custom only**; workspace/`.github` read-only), and exported `parseAgent`/`serializeAgent`/
`validateName` (name must equal the file stem) + `AgentFields` from `agent/agents/loader.ts`. The
Agents screen (`agents-screen.tsx`) has **New agent** + hover-delete on writable rows and a structured
editor.

The picker is `pickFiles()` (`pick-workspace.ts`) — multi-select, no `filters` today.

## Goal

1. **Import one or more `.agent.md` files** — validate each parses (`parseAgent`) and its frontmatter
   `name` equals the file stem (the loader's hard rule via `validateName`), then copy into a chosen
   writable source root as `<name>.agent.md`.
2. Land in a writable source (user default; dropdown when custom folders exist — mirrors `027`'s
   create), reject collisions (per Open questions), refresh the tree. Imported agents become selectable
   in the composer picker and in `026`'s process agent-pool.

## Likely shape (hypothesis — revisit per Open questions)

### A. IPC (`agents:import`, alongside `027`'s create/save/delete in `index.ts`)
- A picker: extend `pickFiles` (or a dedicated `pickAgentImport`) with a `filters` entry for
  `.agent.md` (note: `showOpenDialog` filters match by extension — `agent.md` needs a filter on `md`
  plus a suffix re-check in the handler, since the OS filter can't express a compound `.agent.md`).
- `agents:import({ sourcePaths, dir })`: for each file — read, `parseAgent`, enforce `validateName(name,
  stem)` (reject a mismatch up front, same as `agents:save`), assert `dir` via `writableAgentRoots()`,
  reject collision, then **copy verbatim** to `<dir>/<name>.agent.md` (preserve the file as authored —
  do NOT round-trip through `serializeAgent`, so a hand-tuned agent imports byte-for-byte). Return the
  imported paths. Import is **best-effort per file**: one bad file reports its error; the rest import.

### B. Renderer (`agents-screen.tsx`)
- An **Import** affordance beside **New agent** (dropdown: "New agent" / "Import…"), opening the
  multi-select picker → the location dropdown (when >1 writable root) → import → refresh + select the
  first imported. Per-file errors via `toast` (a summary toast when importing several).

## Open questions to resolve BEFORE building
1. **Name collision.** Reject the colliding file (import the rest) vs auto-suffix vs prompt overwrite.
   Lean **reject-that-file-with-a-message, import the rest** (matches `027`'s collision reject).
2. **Copy verbatim vs re-serialize.** Copy the file as-is (preserves comments, key order, any fields we
   don't model) vs parse→`serializeAgent` (normalizes, drops unknowns). Lean **copy verbatim** — import
   should not mutate a working agent; the editor can normalize later on an explicit save.
3. **Name ≠ stem on import.** The loader requires `name === stem`. If an imported file's frontmatter
   `name` differs from its filename, reject vs rename-file-to-match-name vs rename-name-to-match-file.
   Lean **reject with a clear message** (the user fixes it), avoiding a silent rewrite.
4. **Filter UX.** OS file filters can't express `.agent.md` exactly (only `md`). Filter on `md` + a
   suffix check in the handler, or accept any file + validate by parse. Lean **filter `md` + re-check +
   parse-validate** (belt and suspenders).

## Verification (when built)
- **Unit:** importing a valid `.agent.md` copies it verbatim under a writable root and is rejected for a
  read-only/foreign root, an unparseable file, or a `name`≠`stem` mismatch; a collision is rejected
  while sibling files still import; multi-file import reports per-file outcomes.
- **Manual (real app):** import a shared `reviewer.agent.md`; it appears in the Agents tree, the
  composer agent picker, and a `026` process agent-pool; import two at once, one intentionally broken,
  and confirm the good one lands + the bad one errors clearly.
- `pnpm typecheck` + `pnpm build` clean; verified in the running app.

## Out of scope
- **Export** of an agent — the `.agent.md` is already a plain file on disk (copy it out by hand);
  a one-click export is a later nicety.
- **Create / edit / delete** — `027`.
- **Zip / multi-file agent bundles** — agents are single files; no supporting assets (unlike skills).
- **Skill import** — `035`; **process import/export** — `037`.
