// Parsed metadata from a SKILL.md, per the Agent Skills spec
// (agentskills.io/specification).
export interface SkillMetadata {
  // Skill identifier: 1–64 chars, lowercase alphanumeric + single hyphens,
  // matches the directory name.
  name: string
  // What the skill does AND when to use it. Max 1024 chars.
  description: string
  // Absolute path to the SKILL.md file — read_skill resolves names to this.
  path: string
  // Full markdown body (frontmatter stripped). Loaded eagerly but NOT put in
  // the prompt — read_skill returns it on demand (progressive disclosure).
  body: string
  // Which source this skill came from, for diagnostics (base | user | project).
  source: string
  license?: string
  compatibility?: string
  metadata: Record<string, string>
  // Tool names the skill recommends. Advisory only.
  allowedTools: string[]
}

// One skill-source directory as surfaced to the Settings → Capabilities table.
// `kind` distinguishes the locked built-ins from user-added custom folders:
//   user      — ~/.<system>/skills (seeded once from the app-bundled skills)
//   custom    — a folder the user registered (removable)
//   github    — <workspace>/.github/skills (zero-config, workspace-scoped)
//   workspace — <workspace>/.<system>/skills
// Note: there's no "app" kind — the app-bundled dir seeds `user` on first launch
// and is not itself a live source.
export type SkillSourceKind = "user" | "custom" | "github" | "workspace"
export interface SkillSourceRow {
  path: string
  kind: SkillSourceKind
  skillCount: number
}

// One skill source with its fully-loaded skills, for the Skills view. Unlike
// SkillSourceRow (counts only, for the Settings table), this carries each skill's
// full SkillMetadata — including `body` and the absolute `path` — so the view can
// render and edit SKILL.md content. One entry per source dir, in load order; NOT
// de-duplicated across sources (the view groups by source, so a name present in
// both user and workspace legitimately appears under each).
export interface SkillCatalogEntry {
  path: string
  kind: SkillSourceKind
  skills: SkillMetadata[]
}

// One skill-source folder as a node in the Skills view's nested tree: a source
// dir with a display label and its loaded skills. Used for the second collapsible
// level (a repo's .github/.<system> dir, or a custom folder).
export interface SkillFolder {
  // Absolute source dir (e.g. <repo>/.github/skills).
  path: string
  // Display name for the folder node (repo name, or custom-folder basename).
  label: string
  kind: SkillSourceKind
  skills: SkillMetadata[]
}

// The nested catalog for the Skills view. Global is one flat source (the user
// dir); Workspace and Custom each expand to a list of folders (one per known repo
// / registered custom folder), each with its own skills. Enumerates ALL known
// workspaces, not just the active conversation's, so the view works with no
// active session.
export interface SkillTree {
  global: SkillFolder[]
  workspaces: Array<{ label: string; path: string; folders: SkillFolder[] }>
  custom: SkillFolder[]
}
