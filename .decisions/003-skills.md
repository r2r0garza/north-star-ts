# 003 — Skills system

**Area:** Main — `src/main/agent/skills/` (`types.ts`, `loader.ts`, `prompt.ts`,
`tool.ts`, `sources.ts`), wired in `src/main/agent/index.ts`
**Status:** Implemented

## What

Progressive-disclosure skills, modeled on the Agent Skills spec
(agentskills.io) and LangChain's deepagents pattern.

- A **skill** is a directory containing `SKILL.md` with YAML frontmatter
  (`name`, `description`, optional `license`/`compatibility`/`metadata`/
  `allowed-tools`) and a markdown body.
- **`loader.ts`** scans each source dir, parses + validates frontmatter (spec
  violations warn but still load), caps file size (10MB), and applies last-wins
  override across sources by name.
- **`prompt.ts`** (`buildSkillsPrompt`) puts only **name + description** (+ light
  annotations) into the system prompt — the body stays out (progressive
  disclosure).
- **`tool.ts`** (`createReadSkillTool`) exposes a `read_skill` tool that takes a
  skill **name** and returns the body from memory. A factory closing over the
  loaded skills (skills are workspace-dependent, loaded per chat).
- **`sources.ts`** resolves three source dirs in last-wins order:
  1. app-bundled — `<appPath>/skills/`
  2. user-level — `~/.cowork/skills/`
  3. workspace — `<workspace>/.cowork/skills/`

Shipped one example skill: `skills/git-commit/SKILL.md`. Packaged via
`build.files` (`skills/**/*`).

## Why

- **Progressive disclosure** keeps token cost to metadata only; bodies load on
  demand. Eager body-load into memory (files are small) avoids per-call disk I/O.
- **A dedicated `read_skill` tool** (name, not path) over a generic file read:
  scoped to skills, no path fumbling, can't wander the filesystem.
- **Three layered sources** (last-wins) enable base defaults → personal →
  project-specific overrides.

## Trade-offs / notes

- **`js-yaml` is v5** (`import * as yaml` — v5 dropped the default export; the
  intuitive `import yaml from "js-yaml"` would break). Verified against v5 docs
  via context7: `load` is current (not deprecated), and v5 now throws on empty
  input (handled by the loader's try/catch).
- **`allowedTools` is advisory** — shown in the prompt, not enforced. Real
  enforcement would require tracking an "active skill" across the loop.
- **App-bundled skills are read-only when packaged** (`app.asar`) — see
  `CONSIDERATIONS.md` #2. A future "create skill" feature must write to
  `~/.cowork/skills` or the workspace dir, never the bundled dir.
- **Reloaded every chat turn** — see `CONSIDERATIONS.md` #3. Negligible I/O, and
  edits take effect on the next message without restart.
